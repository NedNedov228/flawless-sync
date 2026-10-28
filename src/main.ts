import { Notice, Plugin, debounce } from "obsidian";
import type { Debouncer, EventRef } from "obsidian";
import { S3Service } from "./s3Client";
import { DEFAULT_SETTINGS, normalizePluginData } from "./settings";
import { S3SyncSettingsTab } from "./settingsTab";
import { StateManager } from "./stateManager";
import { SyncEngine } from "./syncEngine";
import { getErrorMessage } from "./errors";
import type { ConflictStrategy, DerivedKeys, S3SyncPluginData, S3SyncSettings } from "./types";

export default class S3SyncPlugin extends Plugin {
  settings: S3SyncSettings = { ...DEFAULT_SETTINGS };
  // Sync state is stored separately from user settings, but persisted in the same plugin data blob.
  private state = new StateManager();
  private syncInterval: number | null = null;
  private liveSyncInterval: number | null = null;
  private syncInProgress = false;

  private eventRefs: EventRef[] = [];
  private liveSyncDebounce: Debouncer<[], void> | null = null;
  private cachedKeys: DerivedKeys | null = null;

  async onload(): Promise<void> {
    await this.loadPluginState();

    this.setupLiveSyncEvents();

    this.addRibbonIcon("sync", "Sync with S3", () => {
      void this.runSync(true);
    });

    this.addCommand({
      id: "sync-vault",
      name: "Sync vault notes with S3",
      callback: () => {
        void this.runSync(true);
      },
    });

    this.addCommand({
      id: "push-vault-settings",
      name: "Push vault settings & plugins to S3",
      callback: async () => {
        new Notice("Pushing settings and plugins to S3...");
        try {
          const engine = this.createSyncEngine();
          await engine.pushConfig();
          new Notice("Successfully pushed settings and plugins to S3.");
        } catch (error) {
          console.error("Config push failed", error);
          new Notice(`Push failed: ${getErrorMessage(error, "Unknown error.")}`);
        }
      },
    });

    this.addCommand({
      id: "pull-vault-settings",
      name: "Pull vault settings & plugins from S3",
      callback: async () => {
        new Notice("Pulling settings and plugins from S3...");
        try {
          const engine = this.createSyncEngine();
          await engine.pullConfig();
          new Notice(
            "Successfully pulled settings and plugins from S3. Please restart Obsidian for changes to take effect.",
          );
        } catch (error) {
          console.error("Config pull failed", error);
          new Notice(`Pull failed: ${getErrorMessage(error, "Unknown error.")}`);
        }
      },
    });

    this.addCommand({
      id: "create-backup",
      name: "Create encrypted S3 backup",
      callback: async () => {
        new Notice("Creating encrypted backup...");
        try {
          const engine = this.createSyncEngine();
          const path = await engine.createBackup();
          new Notice(`Backup created successfully: ${path}`);
        } catch (error) {
          console.error("Backup failed", error);
          new Notice(`Backup failed: ${getErrorMessage(error, "Unknown error.")}`);
        }
      },
    });

    this.addCommand({
      id: "restore-backup",
      name: "Restore latest encrypted S3 backup",
      callback: async () => {
        new Notice("Restoring latest encrypted backup...");
        try {
          const engine = this.createSyncEngine();
          const path = await engine.restoreLatestBackup();
          new Notice(`Restored from backup: ${path}`);
          // Re-sync afterwards to update S3
          await this.runSync(false);
        } catch (error) {
          console.error("Restore failed", error);
          new Notice(`Restore failed: ${getErrorMessage(error, "Unknown error.")}`);
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
    // Vault listeners are registered exactly once. Re-registering them on every settings
    // change would leak handlers, so only the debounce timer is rebuilt here.
    if (this.eventRefs.length === 0) {
      const trigger = (): void => {
        if (this.settings.liveSync) {
          this.liveSyncDebounce?.();
        }
      };

      this.eventRefs.push(this.app.vault.on("modify", trigger));
      this.eventRefs.push(this.app.vault.on("create", trigger));
      this.eventRefs.push(this.app.vault.on("delete", trigger));
      this.eventRefs.push(this.app.vault.on("rename", trigger));

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
      console.debug(
        "Flawless Sync: New device or cloned settings detected. Wiped local file state to prevent mass deletions.",
      );
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

  createSyncEngine(): SyncEngine {
    return new SyncEngine(
      this.app.vault,
      new S3Service(this.settings),
      this.state,
      this.settings,
      async (path) => this.resolveConflict(path),
      {
        keyCache: this,
        trashFile: (file) => this.app.fileManager.trashFile(file),
      },
    );
  }

  getCachedKeys(): DerivedKeys | null {
    return this.cachedKeys;
  }

  setCachedKeys(keys: DerivedKeys | null): void {
    this.cachedKeys = keys;
  }

  private async resolveConflict(path: string): Promise<ConflictStrategy> {
    const configDir = this.app.vault.configDir;
    const isConfigFile = Boolean(configDir) && path.startsWith(configDir);
    const strategy = isConfigFile
      ? this.settings.configConflictResolution
      : this.settings.conflictResolution;
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

  async runSync(verbose: boolean): Promise<void> {
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
      if (verbose) {
        new Notice(`S3 sync failed: ${getErrorMessage(error, "Unknown sync error.")}`);
      }
    } finally {
      this.syncInProgress = false;
    }
  }
}
