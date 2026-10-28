import { Notice, Plugin, debounce } from "obsidian";
import { S3Service } from "./s3Client";
import { DEFAULT_SETTINGS, normalizePluginData } from "./settings";
import { S3SyncSettingsTab } from "./settingsTab";
import { StateManager } from "./stateManager";
import { ConflictStrategy, SyncEngine } from "./syncEngine";
import type { S3SyncPluginData, S3SyncSettings } from "./types";

export default class S3SyncPlugin extends Plugin {
  settings: S3SyncSettings = { ...DEFAULT_SETTINGS };
  // Sync state is stored separately from user settings, but persisted in the same plugin data blob.
  private state = new StateManager();
  private syncInterval: number | null = null;
  private liveSyncInterval: number | null = null;
  private syncInProgress = false;
  
  private eventRefs: any[] = [];
  private liveSyncDebounce: any;
  private cachedKeys: { aesKey: CryptoKey; hmacKey: CryptoKey, passphrase?: string, vaultSalt?: string } | null = null;

  async onload(): Promise<void> {
    await this.loadPluginState();

    this.setupLiveSyncEvents();

    this.addRibbonIcon("sync", "Sync with S3", async () => {
      await this.runSync(true);
    });

    this.addCommand({
      id: "sync-vault",
      name: "Sync vault notes with S3",
      callback: () => this.runSync(true),
    });

    this.addCommand({
      id: "push-vault-settings",
      name: "Push Vault Settings & Plugins to S3",
      callback: async () => {
        new Notice("Pushing settings and plugins to S3...");
        try {
          const engine = this.createSyncEngine();
          await engine.pushConfig();
          new Notice("Successfully pushed settings and plugins to S3.");
        } catch (e: any) {
          console.error("Config push failed", e);
          new Notice(`Push failed: ${e.message}`);
        }
      },
    });

    this.addCommand({
      id: "pull-vault-settings",
      name: "Pull Vault Settings & Plugins from S3",
      callback: async () => {
        new Notice("Pulling settings and plugins from S3...");
        try {
          const engine = this.createSyncEngine();
          await engine.pullConfig();
          new Notice("Successfully pulled settings and plugins from S3. Please restart Obsidian for changes to take effect.");
        } catch (e: any) {
          console.error("Config pull failed", e);
          new Notice(`Pull failed: ${e.message}`);
        }
      },
    });

    this.addCommand({
      id: "create-backup",
      name: "Create Encrypted S3 Backup",
      callback: async () => {
        new Notice("Creating encrypted backup...");
        try {
          const engine = this.createSyncEngine();
          const path = await engine.createBackup();
          new Notice(`Backup created successfully: ${path}`);
        } catch (e: any) {
          console.error("Backup failed", e);
          new Notice(`Backup failed: ${e.message}`);
        }
      },
    });

    this.addCommand({
      id: "restore-backup",
      name: "Restore Latest Encrypted S3 Backup",
      callback: async () => {
        new Notice("Restoring latest encrypted backup...");
        try {
          const engine = this.createSyncEngine();
          const path = await engine.restoreLatestBackup();
          new Notice(`Restored from backup: ${path}`);
          // Re-sync afterwards to update S3
          await this.runSync(false);
        } catch (e: any) {
          console.error("Restore failed", e);
          new Notice(`Restore failed: ${e.message}`);
        }
      },
    });

    this.addSettingTab(new S3SyncSettingsTab(this.app, this));
    this.restartAutoSync();
    this.setupLiveSync();
  }

  onunload(): void {
    this.stopAutoSync();
    if (this.liveSyncInterval !== null) {
      window.clearInterval(this.liveSyncInterval);
      this.liveSyncInterval = null;
    }
  }

  private saveSettingsDebounced = debounce(async () => {
    await this.savePluginState();
    this.restartAutoSync();
    this.setupLiveSync();
  }, 1000);

  async saveSettings(): Promise<void> {
    this.saveSettingsDebounced();
  }

  setupLiveSync(): void {
    if (this.liveSyncInterval !== null) {
      window.clearInterval(this.liveSyncInterval);
      this.liveSyncInterval = null;
    }

    if (this.settings.liveSync) {
      this.liveSyncInterval = window.setInterval(() => {
        void this.runSync(false);
      }, this.settings.liveSyncPollingMs);
    }
  }

  setupLiveSyncEvents(): void {
    // Clear old events
    // Obsidian's registerEvent puts the event in an internal _events array, which is cleaned on unload.
    // If we call offref without removing it from _events, the list grows forever.
    // However, workspace.offref correctly removes it from the EventBus.
    // To be clean, we should avoid repeatedly registering events if we don't have to.
    if (this.eventRefs.length > 0) {
      // If events are already registered, we just need to update the debounce timer
      // no need to unregister and re-register.
    } else {
      this.eventRefs.push(this.app.vault.on('modify', () => { if (this.settings.liveSync) this.liveSyncDebounce(); }));
      this.eventRefs.push(this.app.vault.on('create', () => { if (this.settings.liveSync) this.liveSyncDebounce(); }));
      this.eventRefs.push(this.app.vault.on('delete', () => { if (this.settings.liveSync) this.liveSyncDebounce(); }));
      this.eventRefs.push(this.app.vault.on('rename', () => { if (this.settings.liveSync) this.liveSyncDebounce(); }));
      
      for (const ref of this.eventRefs) {
        this.registerEvent(ref);
      }
    }

    // Trailing edge debounce (wait for typing/saving burst to finish)
    this.liveSyncDebounce = debounce(() => {
      void this.runSync(false);
    }, this.settings.liveSyncDebounceMs);
  }

  async testConnection(): Promise<void> {
    const validationError = this.validateSettings();
    if (validationError) {
      throw new Error(validationError);
    }

    const s3 = new S3Service(this.settings);
    await s3.testConnection();
  }

  private async loadPluginState(): Promise<void> {
    // Normalization keeps older saved formats readable after internal data-shape changes.
    const pluginData = normalizePluginData(await this.loadData());
    this.settings = pluginData.settings;
    
    // Check for device cloning to prevent mass S3 deletion
    const localInstanceId = window.localStorage.getItem("flawless-sync-instance-id");
    if (!localInstanceId || this.settings.instanceId !== localInstanceId) {
      const newInstanceId = crypto.randomUUID();
      window.localStorage.setItem("flawless-sync-instance-id", newInstanceId);
      this.settings.instanceId = newInstanceId;
      this.state.load([]); // Wipe state! It's a cloned settings file or fresh install.
      await this.savePluginState();
      console.log("Flawless Sync: New device or cloned settings detected. Wiped local file state to prevent mass deletions.");
    } else {
      this.state.load(pluginData.fileStates);
    }
  }

  private async savePluginState(): Promise<void> {
    const pluginData: S3SyncPluginData = {
      settings: this.settings,
      fileStates: this.state.toJSON(),
    };

    await this.saveData(pluginData);
  }

  private createSyncEngine(): SyncEngine {
    return new SyncEngine(
      this.app.vault,
      new S3Service(this.settings),
      this.state,
      this.settings,
      async (path) => this.resolveConflict(path),
      this
    );
  }

  public getCachedKeys() {
    return this.cachedKeys;
  }

  public setCachedKeys(keys: { aesKey: CryptoKey; hmacKey: CryptoKey, passphrase?: string, vaultSalt?: string } | null) {
    this.cachedKeys = keys;
  }

  private async resolveConflict(path: string): Promise<ConflictStrategy> {
    const configDir = (this.app.vault as any).configDir || ".obsidian";
    const strategy = path.startsWith(configDir) ? this.settings.configConflictResolution : this.settings.conflictResolution;
    new Notice(`Conflict detected for "${path}". Resolved using strategy: ${strategy}`);
    return strategy;
  }

  private validateSettings(): string | null {
    if (!this.settings.bucket) {
      return "Set the S3 bucket in plugin settings.";
    }

    if (!this.settings.region) {
      return "Set the S3 region in plugin settings.";
    }

    if (!this.settings.accessKeyId || !this.settings.secretAccessKey) {
      return "Set the S3 access key ID and secret access key in plugin settings.";
    }

    return null;
  }

  private restartAutoSync(): void {
    this.stopAutoSync();

    if (this.settings.autoSyncInterval <= 0) {
      return;
    }

    this.syncInterval = window.setInterval(() => {
      void this.runSync(false);
    }, this.settings.autoSyncInterval * 60 * 1000);
  }

  private stopAutoSync(): void {
    if (this.syncInterval !== null) {
      window.clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  private async runSync(verbose: boolean): Promise<void> {
    const error = this.validateSettings();
    if (error) {
      if (verbose) new Notice(error);
      return;
    }

    if (this.syncInProgress) {
      if (verbose) new Notice("Sync is already running.");
      return;
    }

    this.syncInProgress = true;
    try {
      if (verbose) new Notice("Syncing with S3...");
      const engine = this.createSyncEngine();
      await engine.sync();
      await this.savePluginState();
      if (verbose) new Notice("Sync complete.");
    } catch (error) {
      console.error("S3 sync failed", error);
      const message = error instanceof Error ? error.message : "Unknown sync error.";

      if (verbose) {
        new Notice(`S3 sync failed: ${message}`);
      }
    } finally {
      this.syncInProgress = false;
    }
  }
}
