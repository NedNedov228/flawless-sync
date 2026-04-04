import { Vault } from "obsidian";
import { S3Service } from "./s3Client";
import { StateManager } from "./stateManager";

export type ConflictStrategy = "local-wins" | "remote-wins" | "ask";

export class SyncEngine {
  constructor(
    private vault: Vault,
    private s3: S3Service,
    private state: StateManager,
    private onConflict: (path: string) => Promise<ConflictStrategy>,
  ) {}

  async sync(): Promise<void> {
    const localFiles = this.vault.getFiles();
    const remoteFiles = await this.s3.listAll();
    // Files pulled from remote in this run must not be uploaded again immediately.
    const updatedFromRemote = new Set<string>();

    const localMap = new Map(localFiles.map((file) => [file.path, file]));
    const remoteMap = new Map(remoteFiles.map((file) => [file.path, file]));

    // Phase 1: pull remote-only or remote-newer content into the vault.
    for (const [path, remote] of remoteMap) {
      const local = localMap.get(path);
      const knownState = this.state.get(path);

      if (!local) {
        const content = await this.s3.download(path);
        await this.vault.createBinary(path, content);
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
        const strategy = await this.onConflict(path);
        if (strategy !== "remote-wins") {
          continue;
        }
      }

      const content = await this.s3.download(path);
      await this.vault.modifyBinary(local, content);
      updatedFromRemote.add(path);
    }

    // Phase 2: push local-only or locally modified files to remote storage.
    for (const local of this.vault.getFiles()) {
      if (updatedFromRemote.has(local.path)) {
        continue;
      }

      const knownState = this.state.get(local.path);
      const remoteExists = remoteMap.has(local.path);
      const changedLocally = !knownState || local.stat.mtime > knownState.localMtime;

      if (!changedLocally && remoteExists) {
        continue;
      }

      const content = await this.vault.readBinary(local);
      await this.s3.upload(local.path, content);
    }

    await this.refreshState();
  }

  private async refreshState(): Promise<void> {
    // Refresh against the latest remote listing so the next run compares against confirmed remote metadata.
    const localFiles = this.vault.getFiles();
    const remoteFiles = await this.s3.listAll();
    const localPaths = new Set(localFiles.map((file) => file.path));
    const remoteMap = new Map(remoteFiles.map((file) => [file.path, file]));

    for (const localFile of localFiles) {
      const remoteFile = remoteMap.get(localFile.path);
      if (!remoteFile) {
        this.state.delete(localFile.path);
        continue;
      }

      this.state.set(localFile.path, {
        path: localFile.path,
        localMtime: localFile.stat.mtime,
        remoteMtime: remoteFile.modified.getTime(),
        etag: remoteFile.etag,
      });
    }

    for (const path of Array.from(this.state.keys())) {
      if (!localPaths.has(path) && !remoteMap.has(path)) {
        this.state.delete(path);
      }
    }
  }
}
