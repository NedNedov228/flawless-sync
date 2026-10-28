import { TFile } from "obsidian";
import type { TAbstractFile, Vault } from "obsidian";
import { S3Service } from "./s3Client";
import { StateManager } from "./stateManager";
import { CryptoUtils } from "./crypto";
import type {
  ConflictStrategy,
  DerivedKeys,
  KeyCacheHost,
  LocalFileEntry,
  LocalFileOptions,
  S3SyncSettings,
} from "./types";

export type { ConflictStrategy };

export interface SyncEngineDeps {
  /** Reuses derived keys between sync runs. */
  keyCache?: KeyCacheHost;
  /** Honours the user's "deleted files" preference (trash vs permanent delete). */
  trashFile: (file: TAbstractFile) => Promise<void>;
}

export class SyncEngine {
  constructor(
    private vault: Vault,
    private s3: S3Service,
    private state: StateManager,
    private settings: S3SyncSettings,
    private onConflict: (path: string) => Promise<ConflictStrategy>,
    private deps: SyncEngineDeps,
  ) {}

  private async getKeys(): Promise<DerivedKeys | null> {
    if (!this.settings.passphrase || !this.settings.vaultSalt) {
      return null;
    }

    const cached = this.deps.keyCache?.getCachedKeys();
    if (
      cached &&
      cached.passphrase === this.settings.passphrase &&
      cached.vaultSalt === this.settings.vaultSalt
    ) {
      return cached;
    }

    const aesKey = await CryptoUtils.deriveKey(this.settings.passphrase, this.settings.vaultSalt);
    const hmacKey = await CryptoUtils.deriveHmacKey(aesKey);
    const keys: DerivedKeys = {
      aesKey,
      hmacKey,
      passphrase: this.settings.passphrase,
      vaultSalt: this.settings.vaultSalt,
    };

    this.deps.keyCache?.setCachedKeys(keys);

    return keys;
  }

  /** Obsidian lets users rename the config folder, so always read it from the vault. */
  private getConfigDir(): string {
    return this.vault.configDir;
  }

  private isConfigPath(path: string): boolean {
    const configDir = this.getConfigDir();
    return Boolean(configDir) && path.startsWith(configDir);
  }

  private async ensureFolderExists(path: string): Promise<void> {
    const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (lastSlash === -1) return;

    const dir = path.substring(0, lastSlash);
    if (!dir) return;

    if (this.isConfigPath(path)) {
      const exists = await this.vault.adapter.exists(dir);
      if (!exists) {
        await this.ensureFolderExists(dir);
        try {
          await this.vault.adapter.mkdir(dir);
        } catch {
          // Ignore error if folder was created concurrently
        }
      }
      return;
    }

    const targetFolder = this.vault.getAbstractFileByPath(dir);
    if (!targetFolder) {
      await this.ensureFolderExists(dir);
      try {
        await this.vault.createFolder(dir);
      } catch {
        // Ignore error if folder was created concurrently
      }
    }
  }

  /** Safely write a file: if it already exists, modify it; otherwise create it.
   *  This prevents crashes from calling createBinary on an existing path (which Obsidian rejects). */
  private async safeWriteFile(path: string, content: ArrayBuffer): Promise<void> {
    if (this.isConfigPath(path)) {
      await this.ensureFolderExists(path);
      await this.vault.adapter.writeBinary(path, content);
      return;
    }

    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, content);
      return;
    }

    await this.ensureFolderExists(path);
    await this.vault.createBinary(path, content);
  }

  private async getAllLocalFiles(options: LocalFileOptions): Promise<LocalFileEntry[]> {
    const files: LocalFileEntry[] = [];
    if (options.syncNotes) {
      files.push(...this.vault.getFiles());
    }

    if (!options.syncConfig) {
      return files;
    }

    const configDir = this.getConfigDir();
    if (!configDir) {
      return files;
    }

    try {
      const adapter = this.vault.adapter;
      if (!(await adapter.exists(configDir))) {
        return files;
      }

      const walk = async (path: string): Promise<void> => {
        const list = await adapter.list(path);
        for (const filePath of list.files) {
          const stat = await adapter.stat(filePath);
          files.push({
            path: filePath.replace(/\\/g, "/"),
            stat: { mtime: stat ? stat.mtime : 0 },
          });
        }
        for (const folderPath of list.folders) {
          await walk(folderPath);
        }
      };

      await walk(configDir);
    } catch (error) {
      console.warn("Could not list config dir", error);
    }

    return files;
  }

  private async readLocalFile(path: string): Promise<ArrayBuffer> {
    if (this.isConfigPath(path)) {
      return this.vault.adapter.readBinary(path);
    }

    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error(`Not a file: ${path}`);
    }

    return this.vault.readBinary(file);
  }

  private async deleteLocalFile(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!file) return;

    await this.deps.trashFile(file);
  }

  async sync(): Promise<void> {
    const keys = await this.getKeys();
    if (!keys) {
      throw new Error("Passphrase or vault salt is missing. Please configure them in settings.");
    }

    let remoteFiles = await this.s3.listAll();
    remoteFiles = remoteFiles.filter(
      (file) =>
        !file.path.startsWith("_backups/") &&
        !file.path.startsWith("_config_files/") &&
        file.path !== "_config.json",
    );
    const updatedFromRemote = new Set<string>();

    const localHmacMap = new Map<string, LocalFileEntry>();

    const allLocalFiles = await this.getAllLocalFiles({ syncConfig: false, syncNotes: true });

    for (const file of allLocalFiles) {
      const hmac = await CryptoUtils.hashPath(file.path, keys.hmacKey);
      localHmacMap.set(hmac, file);
    }

    const remoteMap = new Map(remoteFiles.map((file) => [file.path, file]));

    for (const [hmac, remote] of remoteMap) {
      try {
        const local = localHmacMap.get(hmac);

        let knownState = null;
        if (local) {
          knownState = this.state.get(local.path);
        } else {
          for (const statePath of Array.from(this.state.keys())) {
            const state = this.state.get(statePath);
            if (state?.hmac === hmac) {
              knownState = state;
              break;
            }
          }
        }

        // If we don't know the path locally and it's not in state, it's a new remote file.
        if (!local) {
          if (knownState) {
            const remoteChanged =
              remote.etag !== knownState.etag || remote.modified.getTime() > knownState.remoteMtime;
            if (!remoteChanged) {
              await this.s3.delete(hmac);
              this.state.delete(knownState.path);
              continue;
            }
          }

          const encryptedContent = await this.s3.download(hmac);
          const { path, content } = await CryptoUtils.decryptBlob(encryptedContent, keys.aesKey);

          await this.ensureFolderExists(path);
          await this.safeWriteFile(path, content);
          updatedFromRemote.add(path);
          continue;
        }

        if (!knownState) {
          continue;
        }

        const remoteChanged =
          remote.etag !== knownState.etag || remote.modified.getTime() > knownState.remoteMtime;

        if (!remoteChanged) {
          continue;
        }

        const localNewer = local.stat.mtime > knownState.localMtime;
        if (localNewer) {
          const conflictStrategy = await this.onConflict(local.path);

          if (conflictStrategy === "local-wins") {
            continue;
          }

          if (conflictStrategy === "create-copy") {
            const extIndex = local.path.lastIndexOf(".");
            const base = extIndex !== -1 ? local.path.substring(0, extIndex) : local.path;
            const ext = extIndex !== -1 ? local.path.substring(extIndex) : "";
            const conflictPath = `${base} (conflict ${Date.now()})${ext}`;

            const encryptedContent = await this.s3.download(hmac);
            const { content } = await CryptoUtils.decryptBlob(encryptedContent, keys.aesKey);

            await this.ensureFolderExists(conflictPath);
            await this.safeWriteFile(conflictPath, content);
            continue;
          }
        }

        const encryptedContent = await this.s3.download(hmac);
        const { path, content } = await CryptoUtils.decryptBlob(encryptedContent, keys.aesKey);

        await this.safeWriteFile(path, content);
        updatedFromRemote.add(local.path);
      } catch (error) {
        console.error(`Sync: failed to process remote file ${hmac}`, error);
      }
    }

    for (const local of allLocalFiles) {
      if (updatedFromRemote.has(local.path)) {
        continue;
      }

      const knownState = this.state.get(local.path);
      const hmac = await CryptoUtils.hashPath(local.path, keys.hmacKey);
      const remoteExists = remoteMap.has(hmac);
      const changedLocally = !knownState || local.stat.mtime > knownState.localMtime;

      if (!changedLocally) {
        if (remoteExists) {
          continue;
        }

        if (knownState) {
          await this.deleteLocalFile(local.path);
          this.state.delete(local.path);
          continue;
        }
      }

      let content: ArrayBuffer;
      try {
        content = await this.readLocalFile(local.path);
      } catch {
        console.warn(`File ${local.path} could not be read, it may have been deleted during sync.`);
        continue;
      }

      const encryptedContent = await CryptoUtils.encryptBlob(local.path, content, keys.aesKey);
      await this.s3.upload(hmac, encryptedContent);
      // Record provisional state immediately after upload to prevent redundant re-uploads
      // if S3 eventual consistency delays the file appearing in the next listAll().
      this.state.set(local.path, {
        path: local.path,
        hmac,
        localMtime: local.stat.mtime,
        remoteMtime: Date.now(),
        etag: "",
      });
    }

    await this.refreshState(keys);
  }

  async createBackup(): Promise<string> {
    const keys = await this.getKeys();
    if (!keys) throw new Error("No keys available for backup.");

    const backupData: Record<string, string> = {};
    const allFiles = await this.getAllLocalFiles({ syncConfig: true, syncNotes: true });

    for (const file of allFiles) {
      const content = await this.readLocalFile(file.path);
      backupData[file.path] = CryptoUtils.bufferToBase64(content);
    }

    const jsonStr = JSON.stringify(backupData);
    const jsonBytes = new TextEncoder().encode(jsonStr);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `_backups/snapshot-${timestamp}.json`;

    // Encrypt the backup using the same logic but a fake path
    const encrypted = await CryptoUtils.encryptBlob(backupPath, jsonBytes, keys.aesKey);
    await this.s3.upload(backupPath, encrypted);

    return backupPath;
  }

  async restoreLatestBackup(): Promise<string> {
    const keys = await this.getKeys();
    if (!keys) throw new Error("No keys available for restore.");

    const remoteFiles = await this.s3.listAll("_backups");

    if (remoteFiles.length === 0) {
      throw new Error("No backups found on S3.");
    }

    remoteFiles.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    const latest = remoteFiles[0];
    if (!latest) {
      throw new Error("No backups found on S3.");
    }

    const encryptedContent = await this.s3.download(latest.path);

    // The backup is encrypted using a fake path "_backups/snapshot..."
    // But decryptBlob returns the original path it was encrypted with, which we can ignore, and the content bytes.
    const { content: jsonBytes } = await CryptoUtils.decryptBlob(encryptedContent, keys.aesKey);
    const jsonStr = new TextDecoder().decode(jsonBytes);
    const backupData = JSON.parse(jsonStr) as Record<string, string>;

    for (const [path, base64] of Object.entries(backupData)) {
      const bytes = CryptoUtils.base64ToBuffer(base64);
      const content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      await this.ensureFolderExists(path);
      await this.safeWriteFile(path, content);
    }

    return latest.path;
  }

  private async asyncPool<T>(
    concurrency: number,
    items: T[],
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    const executing = new Set<Promise<void>>();
    const errors: unknown[] = [];
    for (const item of items) {
      const task = fn(item)
        .catch((error: unknown) => {
          errors.push(error);
        })
        .finally(() => {
          executing.delete(task);
        });
      executing.add(task);
      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);
    if (errors.length > 0) {
      console.error(`asyncPool: ${errors.length} task(s) failed.`, errors);
    }
  }

  async pushConfig(): Promise<void> {
    const keys = await this.getKeys();
    if (!keys) throw new Error("No keys available for config sync.");

    const manifest: Record<string, string> = {};
    const configFiles = await this.getAllLocalFiles({ syncConfig: true, syncNotes: false });

    console.debug(`Starting push of ${configFiles.length} config files...`);

    // Hash paths for manifest and build upload queue
    for (const file of configFiles) {
      manifest[file.path] = await CryptoUtils.hashPath(file.path, keys.hmacKey);
    }

    let completed = 0;
    // Upload files concurrently
    await this.asyncPool(5, configFiles, async (file) => {
      const content = await this.vault.adapter.readBinary(file.path);
      const hmac = manifest[file.path];
      if (!hmac) {
        console.warn(`pushConfig: no hmac found for ${file.path}, skipping.`);
        return;
      }
      const encryptedContent = await CryptoUtils.encryptBlob(
        file.path,
        new Uint8Array(content),
        keys.aesKey,
      );
      await this.s3.upload(`_config_files/${hmac}`, encryptedContent);
      completed++;
      if (completed % 10 === 0 || completed === configFiles.length) {
        console.debug(`Pushed ${completed}/${configFiles.length} config files...`);
      }
    });

    console.debug("Uploading config manifest...");
    const jsonStr = JSON.stringify(manifest);
    const jsonBytes = new TextEncoder().encode(jsonStr);
    const encryptedContent = await CryptoUtils.encryptBlob("_config.json", jsonBytes, keys.aesKey);
    await this.s3.upload("_config.json", encryptedContent);

    // Cleanup old config files
    try {
      console.debug("Cleaning up old config files...");
      const allFiles = await this.s3.listAll();
      const validHmacs = new Set(Object.values(manifest));
      const oldFiles = allFiles.filter(
        (file) =>
          file.path.startsWith("_config_files/") &&
          !validHmacs.has(file.path.replace("_config_files/", "")),
      );

      await this.asyncPool(5, oldFiles, async (file) => {
        await this.s3.delete(file.path);
      });
    } catch (error) {
      console.warn("Failed to cleanup old config files:", error);
    }

    console.debug("Config push finished successfully.");
  }

  async pullConfig(): Promise<void> {
    const keys = await this.getKeys();
    if (!keys) throw new Error("No keys available for config sync.");

    let encryptedContent: ArrayBuffer;
    try {
      encryptedContent = await this.s3.download("_config.json");
    } catch {
      throw new Error(
        "No configuration found on S3. Please push configuration from another device first.",
      );
    }

    const { content: jsonBytes } = await CryptoUtils.decryptBlob(encryptedContent, keys.aesKey);
    const jsonStr = new TextDecoder().decode(jsonBytes);
    const manifest = JSON.parse(jsonStr) as Record<string, string>;

    const entries = Object.entries(manifest);
    console.debug(`Starting pull of ${entries.length} config files...`);

    let completed = 0;
    await this.asyncPool(5, entries, async ([path, hmac]) => {
      try {
        const fileContent = await this.s3.download(`_config_files/${hmac}`);
        const { content } = await CryptoUtils.decryptBlob(fileContent, keys.aesKey);
        await this.ensureFolderExists(path);
        await this.vault.adapter.writeBinary(path, content);
      } catch (error) {
        console.error(`Failed to download config file ${path}`, error);
      } finally {
        completed++;
        if (completed % 10 === 0 || completed === entries.length) {
          console.debug(`Pulled ${completed}/${entries.length} config files...`);
        }
      }
    });
    console.debug("Config pull finished successfully.");
  }

  private async refreshState(keys: DerivedKeys): Promise<void> {
    const localFiles = await this.getAllLocalFiles({ syncConfig: false, syncNotes: true });
    let remoteFiles = await this.s3.listAll();
    remoteFiles = remoteFiles.filter(
      (file) =>
        !file.path.startsWith("_backups/") &&
        !file.path.startsWith("_config_files/") &&
        file.path !== "_config.json",
    );

    const localPaths = new Set(localFiles.map((file) => file.path));
    const remoteMap = new Map(remoteFiles.map((file) => [file.path, file])); // file.path is hmac

    for (const localFile of localFiles) {
      const hmac = await CryptoUtils.hashPath(localFile.path, keys.hmacKey);
      const remoteFile = remoteMap.get(hmac);

      if (remoteFile) {
        this.state.set(localFile.path, {
          path: localFile.path,
          hmac,
          localMtime: localFile.stat.mtime,
          remoteMtime: remoteFile.modified.getTime(),
          etag: remoteFile.etag,
        });
      }
    }

    for (const path of Array.from(this.state.keys())) {
      if (!localPaths.has(path)) {
        const state = this.state.get(path);
        if (state && !remoteMap.has(state.hmac)) {
          this.state.delete(path);
        }
      }
    }
  }
}
