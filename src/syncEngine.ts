import { Vault, TFile } from "obsidian";
import { S3Service } from "./s3Client";
import { StateManager } from "./stateManager";
import { CryptoUtils } from "./crypto";
import type { S3SyncSettings } from "./types";

export type ConflictStrategy = "local-wins" | "remote-wins" | "ask";

export class SyncEngine {
  constructor(
    private vault: Vault,
    private s3: S3Service,
    private state: StateManager,
    private settings: S3SyncSettings,
    private onConflict: (path: string) => Promise<ConflictStrategy>,
  ) {}

  private async getKeys(): Promise<{ aesKey: CryptoKey; hmacKey: CryptoKey } | null> {
    if (!this.settings.passphrase || !this.settings.vaultSalt) {
      return null;
    }
    const aesKey = await CryptoUtils.deriveKey(this.settings.passphrase, this.settings.vaultSalt);
    const hmacKey = await CryptoUtils.deriveHmacKey(aesKey);
    return { aesKey, hmacKey };
  }

  async sync(): Promise<void> {
    const keys = await this.getKeys();
    if (!keys) {
      throw new Error("Passphrase or vault salt is missing. Please configure them in settings.");
    }

    const localFiles = this.vault.getFiles();
    const remoteFiles = await this.s3.listAll();
    const updatedFromRemote = new Set<string>();

    const localMap = new Map<string, TFile>();
    const localHmacMap = new Map<string, TFile>();

    for (const file of localFiles) {
      localMap.set(file.path, file);
      const hmac = await CryptoUtils.hashPath(file.path, keys.hmacKey);
      localHmacMap.set(hmac, file);
    }

    const remoteMap = new Map(remoteFiles.map((file) => [file.path, file])); // file.path is actually the HMAC

    // Phase 1: pull remote-only or remote-newer content into the vault.
    for (const [hmac, remote] of remoteMap) {
      const local = localHmacMap.get(hmac);
      
      // We need to look up knownState by local path if local exists, otherwise we search by hmac.
      // Wait, knownState in StateManager is keyed by local path. Let's find it.
      let knownState = null;
      if (local) {
        knownState = this.state.get(local.path);
      } else {
        // If we don't have the file locally, check if it was known before (e.g. deleted locally).
        for (const state of Array.from(this.state.keys())) {
          const s = this.state.get(state);
          if (s?.hmac === hmac) {
            knownState = s;
            break;
          }
        }
      }

      if (!local) {
        if (knownState) {
          const remoteChanged = remote.etag !== knownState.etag || remote.modified.getTime() > knownState.remoteMtime;
          if (!remoteChanged) {
            // Deleted locally, delete remotely
            await this.s3.delete(hmac);
            this.state.delete(knownState.path);
            continue;
          }
        }

        const encryptedContent = await this.s3.download(hmac);
        const { path, content } = await CryptoUtils.decryptBlob(encryptedContent, keys.aesKey);
        await this.vault.createBinary(path, content);
        updatedFromRemote.add(path);
        continue;
      }

      if (!knownState) {
        continue; // Should not happen often if it exists locally but no state, it's a new local file. We push it in phase 2.
      }

      const remoteChanged =
        remote.etag !== knownState.etag ||
        remote.modified.getTime() > knownState.remoteMtime;

      if (!remoteChanged) {
        continue;
      }

      const localNewer = local.stat.mtime > knownState.localMtime;
      if (localNewer) {
        const strategy = await this.onConflict(local.path);
        if (strategy !== "remote-wins") {
          continue;
        }
      }

      const encryptedContent = await this.s3.download(hmac);
      const { content } = await CryptoUtils.decryptBlob(encryptedContent, keys.aesKey);
      await this.vault.modifyBinary(local, content);
      updatedFromRemote.add(local.path);
    }

    // Phase 2: push local-only or locally modified files to remote storage.
    for (const local of this.vault.getFiles()) {
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
          // Deleted remotely, delete locally
          if ((this.vault as any).trash) {
            await (this.vault as any).trash(local, false);
          } else if ((this.vault as any).delete) {
            await (this.vault as any).delete(local.path);
          }
          this.state.delete(local.path);
          continue;
        }
      }

      const content = await this.vault.readBinary(local);
      const encryptedContent = await CryptoUtils.encryptBlob(local.path, content, keys.aesKey);
      await this.s3.upload(hmac, encryptedContent);
    }

    await this.refreshState(keys);
  }

  private async refreshState(keys: { aesKey: CryptoKey; hmacKey: CryptoKey }): Promise<void> {
    const localFiles = this.vault.getFiles();
    const remoteFiles = await this.s3.listAll();
    const localPaths = new Set(localFiles.map((file) => file.path));
    const remoteMap = new Map(remoteFiles.map((file) => [file.path, file])); // file.path is hmac

    for (const localFile of localFiles) {
      const hmac = await CryptoUtils.hashPath(localFile.path, keys.hmacKey);
      const remoteFile = remoteMap.get(hmac);
      
      if (!remoteFile) {
        this.state.delete(localFile.path);
        continue;
      }

      this.state.set(localFile.path, {
        path: localFile.path,
        hmac: hmac,
        localMtime: localFile.stat.mtime,
        remoteMtime: remoteFile.modified.getTime(),
        etag: remoteFile.etag,
      });
    }

    for (const path of Array.from(this.state.keys())) {
      if (!localPaths.has(path)) {
        // We only remove from state if it doesn't exist locally.
        this.state.delete(path);
      }
    }
  }
}
