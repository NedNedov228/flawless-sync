import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { CryptoUtils } from "./crypto";
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
      .setName("E2E Encryption Passphrase")
      .setDesc("Used to derive the encryption key. Do not lose this!")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter strong passphrase")
          .setValue(this.plugin.settings.passphrase)
          .onChange(async (value) => {
            this.plugin.settings.passphrase = value;
            if (value && !this.plugin.settings.vaultSalt) {
              this.plugin.settings.vaultSalt = await CryptoUtils.generateSalt();
              this.display(); // Refresh UI to show the new salt
            }
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Vault Salt")
      .setDesc("Auto-generated. MUST be identical across all your devices to decrypt files!")
      .addText((text) => {
        text
          .setPlaceholder("No salt generated yet")
          .setValue(this.plugin.settings.vaultSalt)
          .onChange(async (value) => {
            this.plugin.settings.vaultSalt = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Stealth Token (X-Vault-Auth)")
      .setDesc("Optional. Used for camouflage proxy to bypass DPI.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter stealth token")
          .setValue(this.plugin.settings.stealthToken)
          .onChange(async (value) => {
            this.plugin.settings.stealthToken = value.trim();
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
            // saveSettings automatically calls restartAutoSync
          });
      });

    new Setting(containerEl)
      .setName("Live Sync (Real-time)")
      .setDesc("Automatically sync files in real-time as you edit or delete them.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.liveSync)
          .onChange(async (value) => {
            this.plugin.settings.liveSync = value;
            await this.plugin.saveSettings();
            this.plugin.setupLiveSync();
          });
      });

    new Setting(containerEl)
      .setName("Live Sync Polling Interval (ms)")
      .setDesc("How often to check for remote changes (default: 1500). Lower is faster but uses more CPU/Battery.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "100";
        text
          .setPlaceholder("1500")
          .setValue(String(this.plugin.settings.liveSyncPollingMs))
          .onChange(async (value) => {
            const parsedValue = Number.parseInt(value, 10);
            this.plugin.settings.liveSyncPollingMs =
              Number.isFinite(parsedValue) && parsedValue >= 100 ? parsedValue : 1500;
            await this.plugin.saveSettings();
            this.plugin.setupLiveSync();
          });
      });

    new Setting(containerEl)
      .setName("Live Sync Typing Debounce (ms)")
      .setDesc("How long to wait after you stop typing before uploading (default: 500).")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "100";
        text
          .setPlaceholder("500")
          .setValue(String(this.plugin.settings.liveSyncDebounceMs))
          .onChange(async (value) => {
            const parsedValue = Number.parseInt(value, 10);
            this.plugin.settings.liveSyncDebounceMs =
              Number.isFinite(parsedValue) && parsedValue >= 100 ? parsedValue : 500;
            await this.plugin.saveSettings();
            this.plugin.setupLiveSyncEvents(); // We'll rename the setup for debounce
          });
      });

    new Setting(containerEl)
      .setName("Conflict Resolution Strategy")
      .setDesc("How to handle conflicts when a file is edited on multiple devices at the same time.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("local-wins", "Local Wins (Overwrite remote)")
          .addOption("remote-wins", "Remote Wins (Overwrite local)")
          .addOption("create-copy", "Create Copy (Keep both)")
          .setValue(this.plugin.settings.conflictResolution)
          .onChange(async (value: "local-wins" | "remote-wins" | "create-copy") => {
            this.plugin.settings.conflictResolution = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Settings & Plugins Conflict Strategy")
      .setDesc("How to handle conflicts specifically for the .obsidian folder (settings and plugins).")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("local-wins", "Local Wins (Overwrite remote)")
          .addOption("remote-wins", "Remote Wins (Overwrite local)")
          .addOption("create-copy", "Create Copy (Keep both)")
          .setValue(this.plugin.settings.configConflictResolution)
          .onChange(async (value: "local-wins" | "remote-wins" | "create-copy") => {
            this.plugin.settings.configConflictResolution = value;
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

    new Setting(containerEl)
      .setName("Backup & Restore")
      .setDesc("Create an encrypted snapshot of the entire vault on S3, or restore the latest one.")
      .addButton((button) => {
        button
          .setButtonText("Create Backup")
          .onClick(async () => {
            button.setButtonText("Creating...");
            try {
              const engine = (this.plugin as any).createSyncEngine();
              await engine.createBackup();
              new Notice("Backup created successfully.");
            } catch (e: any) {
              new Notice(`Backup failed: ${e.message}`);
            } finally {
              button.setButtonText("Create Backup");
            }
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Restore Latest")
          .onClick(async () => {
            if (confirm("Are you sure? This will overwrite your current vault with the latest backup!")) {
              button.setButtonText("Restoring...");
              try {
                const engine = (this.plugin as any).createSyncEngine();
                await engine.restoreLatestBackup();
                new Notice("Backup restored successfully.");
                (this.plugin as any).runSync(false);
              } catch (e: any) {
                new Notice(`Restore failed: ${e.message}`);
              } finally {
                button.setButtonText("Restore Latest");
              }
            }
          });
      });
  }
}
