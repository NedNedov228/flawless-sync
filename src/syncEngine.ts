import type { Vault, TFile } from "obsidian";
import { S3Service } from "./s3Client";
import { StateManager } from "./stateManager";
import { CryptoUtils } from "./crypto";
import type { S3SyncSettings } from "./types";

export type ConflictStrategy = "local-wins" | "remote-wins" | "create-copy";

export class SyncEngine {
  constructor(
    private vault: Vault,
    private s3: S3Service,
    private state: StateManager,
    private settings: S3SyncSettings,
    private onConflict: (path: string) => Promise<ConflictStrategy>,
    private plugin?: any
  ) {}

  private async getKeys(): Promise<{ aesKey: CryptoKey; hmacKey: CryptoKey } | null> {
    if (!this.settings.passphrase || !this.settings.vaultSalt) {
      return null;
    }
    
    if (this.plugin) {
      const cached = this.plugin.getCachedKeys();
      if (
        cached &&
        cached.passphrase === this.settings.passphrase &&
        cached.vaultSalt === this.settings.vaultSalt
      ) {
        return cached;
      }
    }

    const aesKey = await CryptoUtils.deriveKey(this.settings.passphrase, this.settings.vaultSalt);
    const hmacKey = await CryptoUtils.deriveHmacKey(aesKey);
    const keys = { aesKey, hmacKey, passphrase: this.settings.passphrase, vaultSalt: this.settings.vaultSalt };
    
    if (this.plugin) {
      this.plugin.setCachedKeys(keys);
    }
    
    return keys;
  }

  private getConfigDir(): string {
    return (this.vault as any).configDir || ".obsidian";
  }

  private async ensureFolderExists(path: string): Promise<void> {
    const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (lastSlash === -1) return;
    
    const dir = path.substring(0, lastSlash);
    if (!dir) return;

    if (path.startsWith(this.getConfigDir())) {
      const exists = await (this.vault.adapter as any).exists(dir);
      if (!exists) {
        await this.ensureFolderExists(dir);
        try {
          await (this.vault.adapter as any).mkdir(dir);
        } catch (e) {
          // Ignore error if folder was created concurrently
        }
      }
    } else {
      const targetFolder = this.vault.getAbstractFileByPath(dir);
      if (!targetFolder) {
        await this.ensureFolderExists(dir);
        try {
          await this.vault.createFolder(dir);
        } catch (e) {
          // Ignore error if folder was created concurrently
        }
      }
    }
  }

  /** Safely write a file: if it already exists, modify it; otherwise create it.
   *  This prevents crashes from calling createBinary on an existing path (which Obsidian rejects). */
  private async safeWriteFile(path: string, content: ArrayBuffer): Promise<void> {
    if (path.startsWith(this.getConfigDir())) {
      await this.ensureFolderExists(path);
      await (this.vault.adapter as any).writeBinary(path, content);
    } else {
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing && !("children" in existing)) {
        await this.vault.modifyBinary(existing as TFile, content);
      } else {
        await this.ensureFolderExists(path);
        await this.vault.createBinary(path, content);
      }
    }
  }

  private async getAllLocalFiles(options: { syncConfig: boolean; syncNotes: boolean }): Promise<any[]> {
    let files: any[] = [];
    if (options.syncNotes) {
      files = files.concat(this.vault.getFiles());
    }

    const configDir = this.getConfigDir();
    const adapter = this.vault.adapter as any;

    if (options.syncConfig) {
      try {
        if (await adapter.exists(configDir)) {
          const walk = async (path: string) => {
            const list = await adapter.list(path);
            for (const f of list.files) {
              const st = await adapter.stat(f);
              const normalizedPath = f.replace(/\\/g, "/");
              files.push({ path: normalizedPath, stat: { mtime: st ? st.mtime : 0 } });
            }
            for (const d of list.folders) {
              await walk(d);
            }
          };
          await walk(configDir);
        }
      } catch (e) {
        console.warn("Could not list config dir", e);
      }
    }
    
    return files;
  }

  async sync(): Promise<void> {
    const keys = await this.getKeys();
    if (!keys) {
      throw new Error("Passphrase or vault salt is missing. Please configure them in settings.");
    }

    let remoteFiles = await this.s3.listAll();
    remoteFiles = remoteFiles.filter(f => !f.path.startsWith("_backups/") && !f.path.startsWith("_config_files/") && f.path !== "_config.json");
    const updatedFromRemote = new Set<string>();
    
    const localHmacMap = new Map<string, any>();
    
    const allLocalFiles = await this.getAllLocalFiles({ syncConfig: false, syncNotes: true });

    for (const f of allLocalFiles) {
      const hmac = await CryptoUtils.hashPath(f.path, keys.hmacKey);
      localHmacMap.set(hmac, f);
    }

    const remoteMap = new Map(remoteFiles.map((file) => [file.path, file]));

    for (const [hmac, remote] of remoteMap) {
      try {
        const local = localHmacMap.get(hmac);
        
        let knownState = null;
        if (local) {
          knownState = this.state.get(local.path);
        } else {
          for (const state of Array.from(this.state.keys())) {
            const s = this.state.get(state);
            if (s?.hmac === hmac) {
              knownState = s;
              break;
            }
          }
        }

        // If we don't know the path locally and it's not in state, it's a new remote file.
        if (!local) {
          if (knownState) {
            const remoteChanged = remote.etag !== knownState.etag || remote.modified.getTime() > knownState.remoteMtime;
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
          remote.etag !== knownState.etag ||
          remote.modified.getTime() > knownState.remoteMtime;

        if (!remoteChanged) {
          continue;
        }

        const localNewer = local.stat.mtime > knownState.localMtime;
        if (localNewer) {
          const conflictStrat = await this.onConflict(local.path);

          if (conflictStrat === "local-wins") {
            continue;
          } else if (conflictStrat === "create-copy") {
            const ext = local.path.lastIndexOf(".");
            const base = ext !== -1 ? local.path.substring(0, ext) : local.path;
            const extStr = ext !== -1 ? local.path.substring(ext) : "";
            const conflictPath = `${base} (conflict ${Date.now()})${extStr}`;
            
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
      } catch (e) {
        console.error(`Sync: failed to process remote file ${hmac}`, e);
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
        } else if (knownState) {
          if ((this.vault as any).trash) {
            await (this.vault as any).trash(local, false);
          } else if ((this.vault as any).delete) {
            await (this.vault as any).delete(local.path);
          }
          this.state.delete(local.path);
          continue;
        }
      }

      let content: ArrayBuffer;
      try {
        if (local.path.startsWith(this.getConfigDir())) {
          content = await (this.vault.adapter as any).readBinary(local.path);
        } else {
          content = await this.vault.readBinary(local as TFile);
        }
      } catch (e) {
        console.warn(`File ${local.path} could not be read, it may have been deleted during sync.`);
        continue;
      }
      
      const encryptedContent = await CryptoUtils.encryptBlob(local.path, content, keys.aesKey);
      await this.s3.upload(hmac, encryptedContent);
      // Record provisional state immediately after upload to prevent redundant re-uploads
      // if S3 eventual consistency delays the file appearing in the next listAll().
      this.state.set(local.path, {
        path: local.path,
        hmac: hmac,
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
      let content: ArrayBuffer;
      if (file.path.startsWith(this.getConfigDir())) {
        content = await (this.vault.adapter as any).readBinary(file.path);
      } else {
        content = await this.vault.readBinary(file as TFile);
      }
      backupData[file.path] = CryptoUtils.bufferToBase64(content);
    }

    const jsonStr = JSON.stringify(backupData);
    const enc = new TextEncoder();
    const jsonBytes = enc.encode(jsonStr);

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
    const dec = new TextDecoder();
    const jsonStr = dec.decode(jsonBytes);
    const backupData = JSON.parse(jsonStr) as Record<string, string>;

    for (const [path, base64] of Object.entries(backupData)) {
      const content = CryptoUtils.base64ToBuffer(base64);
      
      let targetFile = this.vault.getAbstractFileByPath(path);
      if (!targetFile && path.startsWith(this.getConfigDir())) {
         await this.ensureFolderExists(path);
         await (this.vault.adapter as any).writeBinary(path, content);
      } else if (targetFile && !("children" in targetFile)) {
        await this.vault.modifyBinary(targetFile as TFile, content);
      } else {
        await this.ensureFolderExists(path);
        await this.vault.createBinary(path, content);
      }
    }

    return latest.path;
  }

  private async asyncPool<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
    const executing = new Set<Promise<void>>();
    const errors: unknown[] = [];
    for (const item of items) {
      const p = fn(item).catch((e) => { errors.push(e); }).finally(() => { executing.delete(p); });
      executing.add(p);
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
    
    console.log(`Starting push of ${configFiles.length} config files...`);

    // Hash paths for manifest and build upload queue
    for (const f of configFiles) {
      manifest[f.path] = await CryptoUtils.hashPath(f.path, keys.hmacKey);
    }

    let completed = 0;
    // Upload files concurrently
    await this.asyncPool(5, configFiles, async (f) => {
      const content = await (this.vault.adapter as any).readBinary(f.path);
      const hmac = manifest[f.path];
      if (!hmac) {
        console.warn(`pushConfig: no hmac found for ${f.path}, skipping.`);
        return;
      }
      const encryptedContent = await CryptoUtils.encryptBlob(f.path, new Uint8Array(content), keys.aesKey);
      await this.s3.upload(`_config_files/${hmac}`, encryptedContent);
      completed++;
      if (completed % 10 === 0 || completed === configFiles.length) {
        console.log(`Pushed ${completed}/${configFiles.length} config files...`);
      }
    });
    
    console.log("Uploading config manifest...");
    // Upload manifest
    const jsonStr = JSON.stringify(manifest);
    const jsonBytes = new TextEncoder().encode(jsonStr);
    const encryptedContent = await CryptoUtils.encryptBlob("_config.json", jsonBytes, keys.aesKey);
    await this.s3.upload("_config.json", encryptedContent);
    
    // Cleanup old config files
    try {
      console.log("Cleaning up old config files...");
      const allFiles = await this.s3.listAll();
      const validHmacs = new Set(Object.values(manifest));
      const oldFiles = allFiles.filter(f => f.path.startsWith("_config_files/") && !validHmacs.has(f.path.replace("_config_files/", "")));
      
      await this.asyncPool(5, oldFiles, async (f) => {
        await this.s3.delete(f.path);
      });
    } catch (e) {
      console.warn("Failed to cleanup old config files:", e);
    }
    
    console.log("Config push finished successfully.");
  }

  async pullConfig(): Promise<void> {
    const keys = await this.getKeys();
    if (!keys) throw new Error("No keys available for config sync.");

    let encryptedContent;
    try {
      encryptedContent = await this.s3.download("_config.json");
    } catch (e) {
      throw new Error("No configuration found on S3. Please push configuration from another device first.");
    }
    
    const { content: jsonBytes } = await CryptoUtils.decryptBlob(encryptedContent, keys.aesKey);
    const jsonStr = new TextDecoder().decode(jsonBytes);
    const manifest = JSON.parse(jsonStr) as Record<string, string>;

    const entries = Object.entries(manifest);
    console.log(`Starting pull of ${entries.length} config files...`);

    let completed = 0;
    await this.asyncPool(5, entries, async ([path, hmac]) => {
      try {
        const fileContent = await this.s3.download(`_config_files/${hmac}`);
        const { content } = await CryptoUtils.decryptBlob(fileContent, keys.aesKey);
        await this.ensureFolderExists(path);
        await (this.vault.adapter as any).writeBinary(path, content);
      } catch (e) {
        console.error(`Failed to download config file ${path}`, e);
      } finally {
        completed++;
        if (completed % 10 === 0 || completed === entries.length) {
          console.log(`Pulled ${completed}/${entries.length} config files...`);
        }
      }
    });
    console.log("Config pull finished successfully.");
  }

  private async refreshState(keys: { aesKey: CryptoKey; hmacKey: CryptoKey }): Promise<void> {
    const localFiles = await this.getAllLocalFiles({ syncConfig: false, syncNotes: true });
    let remoteFiles = await this.s3.listAll();
    remoteFiles = remoteFiles.filter((f) => !f.path.startsWith("_backups/") && !f.path.startsWith("_config_files/") && f.path !== "_config.json");
    
    const localPaths = new Set(localFiles.map((file) => file.path));
    const remoteMap = new Map(remoteFiles.map((file) => [file.path, file])); // file.path is hmac

    for (const localFile of localFiles) {
      const hmac = await CryptoUtils.hashPath(localFile.path, keys.hmacKey);
      const remoteFile = remoteMap.get(hmac);
      
      if (remoteFile) {
        this.state.set(localFile.path, {
          path: localFile.path,
          hmac: hmac,
          localMtime: localFile.stat.mtime,
          remoteMtime: remoteFile.modified.getTime(),
          etag: remoteFile.etag,
        });
      }
    }

    for (const path of Array.from(this.state.keys())) {
      if (!localPaths.has(path)) {
        const stateObj = this.state.get(path);
        if (stateObj && !remoteMap.has(stateObj.hmac)) {
          this.state.delete(path);
        }
      }
    }
  }
}
