import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type S3SyncPlugin from "./main";

export class S3SyncSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: S3SyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("S3 sync").setHeading();

    new Setting(containerEl)
      .setName("Bucket")
      .setDesc("Target bucket name.")
      .addText((text) => {
        text
          .setPlaceholder("Enter bucket name")
          .setValue(this.plugin.settings.bucket)
          .onChange(async (value) => {
            this.plugin.settings.bucket = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Region")
      .setDesc("Region used by your S3 or S3-compatible provider.")
      .addText((text) => {
        text
          .setPlaceholder("Enter region")
          .setValue(this.plugin.settings.region)
          .onChange(async (value) => {
            this.plugin.settings.region = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Access key ID")
      .setDesc("Stored locally in the Obsidian plugin data.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter access key")
          .setValue(this.plugin.settings.accessKeyId)
          .onChange(async (value) => {
            this.plugin.settings.accessKeyId = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Secret access key")
      .setDesc("Stored locally in the Obsidian plugin data.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Secret key")
          .setValue(this.plugin.settings.secretAccessKey)
          .onChange(async (value) => {
            this.plugin.settings.secretAccessKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Custom endpoint")
      .setDesc("Optional endpoint for S3-compatible services.")
      .addText((text) => {
        text
          .setPlaceholder("https://s3.example.com")
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (value) => {
            this.plugin.settings.endpoint = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Prefix")
      .setDesc("Folder inside the bucket where vault files are stored.")
      .addText((text) => {
        text
          .setPlaceholder("Enter prefix")
          .setValue(this.plugin.settings.prefix)
          .onChange(async (value) => {
            this.plugin.settings.prefix = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Auto-sync interval")
      .setDesc("Sync interval in minutes. Set to 0 to disable background sync.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.autoSyncInterval))
          .onChange(async (value) => {
            const parsedValue = Number.parseInt(value, 10);
            this.plugin.settings.autoSyncInterval =
              Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : 0;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Save the current settings and test whether the bucket is reachable.")
      .addButton((button) => {
        button.setButtonText("Test connection").setCta().onClick(async () => {
          await this.plugin.saveSettings();

          try {
            await this.plugin.testConnection();
            new Notice("S3 connection is working.");
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown connection error.";
            new Notice(`S3 connection failed: ${message}`);
          }
        });
      });
  }
}
