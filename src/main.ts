import { Notice, Plugin } from "obsidian";
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
  private syncInProgress = false;

  async onload(): Promise<void> {
    await this.loadPluginState();

    this.addRibbonIcon("sync", "Sync with S3", async () => {
      await this.runSync(true);
    });

    this.addCommand({
      id: "sync-vault",
      name: "Sync vault with S3",
      callback: () => this.runSync(true),
    });

    this.addSettingTab(new S3SyncSettingsTab(this.app, this));
    this.restartAutoSync();
  }

  onunload(): void {
    this.stopAutoSync();
  }

  async saveSettings(): Promise<void> {
    await this.savePluginState();
    this.restartAutoSync();
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
    this.state.load(pluginData.fileStates);
  }

  private async savePluginState(): Promise<void> {
    const pluginData: S3SyncPluginData = {
      settings: this.settings,
      fileStates: this.state.toJSON(),
    };

    await this.saveData(pluginData);
  }

  private createSyncEngine(): SyncEngine {
    // A fresh client is created per run so endpoint and credentials always match the latest settings.
    return new SyncEngine(
      this.app.vault,
      new S3Service(this.settings),
      this.state,
      async (path) => this.resolveConflict(path),
    );
  }

  private async resolveConflict(path: string): Promise<ConflictStrategy> {
    new Notice(`Conflict detected for "${path}". Keeping the local version.`);
    return "local-wins";
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

  private async runSync(showNotices: boolean): Promise<void> {
    // Obsidian may trigger manual and interval sync close together, so guard against overlapping runs.
    const validationError = this.validateSettings();
    if (validationError) {
      if (showNotices) {
        new Notice(validationError);
      }
      return;
    }

    if (this.syncInProgress) {
      if (showNotices) {
        new Notice("Sync is already running.");
      }
      return;
    }

    this.syncInProgress = true;

    try {
      if (showNotices) {
        new Notice("Syncing with S3...");
      }

      await this.createSyncEngine().sync();
      await this.savePluginState();

      if (showNotices) {
        new Notice("Sync complete.");
      }
    } catch (error) {
      console.error("S3 sync failed", error);
      const message = error instanceof Error ? error.message : "Unknown sync error.";

      if (showNotices) {
        new Notice(`S3 sync failed: ${message}`);
      }
    } finally {
      this.syncInProgress = false;
    }
  }
}
