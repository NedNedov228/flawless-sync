import { test } from "node:test";
import { strict as assert } from "node:assert";
import { webcrypto } from "node:crypto";

// The plugin runs inside the Obsidian renderer, so provide the browser globals it relies on.
const globalScope = globalThis as unknown as Record<string, unknown>;
globalScope.window = {
  crypto: webcrypto,
  btoa: (str: string) => Buffer.from(str, "binary").toString("base64"),
  atob: (b64: string) => Buffer.from(b64, "base64").toString("binary"),
};

import { TFile } from "obsidian";
import { StateManager } from "../src/stateManager";
import { SyncEngine } from "../src/syncEngine";
import { CryptoUtils } from "../src/crypto";
import type { RemoteFile } from "../src/s3Client";
import type { ConflictStrategy, S3SyncSettings } from "../src/types";

type VaultFile = TFile;

type StoredFile = { content: Uint8Array; mtime: number };

function makeTFile(path: string, mtime: number): TFile {
  const file = new TFile();
  file.path = path;
  file.stat = { ctime: mtime, mtime, size: 0 };
  return file;
}

class FakeVault {
  private files = new Map<string, StoredFile>();
  private clock = 100;
  readonly configDir = "." + "obsidian";
  readonly trashed: string[] = [];

  constructor(initialFiles: Array<{ path: string; content: string; mtime?: number }> = []) {
    for (const file of initialFiles) {
      this.files.set(file.path, {
        content: this.toBytes(file.content),
        mtime: file.mtime ?? this.nextMtime(),
      });
    }
  }

  getFiles(): VaultFile[] {
    return Array.from(this.files.entries()).map(([path, file]) => makeTFile(path, file.mtime));
  }

  async createBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, {
      content: new Uint8Array(content),
      mtime: this.nextMtime(),
    });
  }

  async modifyBinary(file: VaultFile, content: ArrayBuffer): Promise<void> {
    this.files.set(file.path, {
      content: new Uint8Array(content),
      mtime: this.nextMtime(),
    });
  }

  async readBinary(file: VaultFile): Promise<ArrayBuffer> {
    const stored = this.files.get(file.path);
    assert.ok(stored, `Missing file ${file.path}`);
    return stored.content.buffer.slice(
      stored.content.byteOffset,
      stored.content.byteOffset + stored.content.byteLength,
    );
  }

  readText(path: string): string | undefined {
    const stored = this.files.get(path);
    return stored ? new TextDecoder().decode(stored.content) : undefined;
  }

  getMtime(path: string): number | undefined {
    return this.files.get(path)?.mtime;
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async trash(file: { path: string }, _system: boolean): Promise<void> {
    this.trashed.push(file.path);
    this.files.delete(file.path);
  }

  getAbstractFileByPath(path: string): VaultFile | null {
    const stored = this.files.get(path);
    if (!stored) return null;
    return makeTFile(path, stored.mtime);
  }

  get adapter(): {
    exists: (path: string) => Promise<boolean>;
    writeBinary: (path: string, content: ArrayBuffer) => Promise<void>;
    readBinary: (path: string) => Promise<ArrayBuffer>;
    list: (dirPath: string) => Promise<{ files: string[]; folders: string[] }>;
    stat: (path: string) => Promise<{ ctime: number; mtime: number; size: number } | null>;
    mkdir: (path: string) => Promise<void>;
    fs: Map<string, StoredFile>;
  } {
    return {
      exists: async () => true,
      writeBinary: async (path: string, content: ArrayBuffer) => this.createBinary(path, content),
      readBinary: async (path: string) => this.readBinary(makeTFile(path, 0)),
      list: async (dirPath: string) => {
        const files: string[] = [];
        for (const [p] of this.files) {
          if (dirPath === "/" || p.startsWith(dirPath + "/")) files.push(p);
        }
        return { files, folders: [] };
      },
      stat: async (path: string) => {
        const stored = this.files.get(path);
        return stored ? { ctime: stored.mtime, mtime: stored.mtime, size: 0 } : null;
      },
      mkdir: async () => undefined,
      fs: this.files,
    };
  }

  private nextMtime(): number {
    this.clock += 1;
    return this.clock;
  }

  private toBytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
  }
}

type StoredRemote = { content: Uint8Array; etag: string; modified: number };

class FakeS3Service {
  private remoteFiles = new Map<string, StoredRemote>();
  private clock = 500;
  uploads: string[] = [];
  downloads: string[] = [];
  deletions: string[] = [];

  get files(): Map<string, StoredRemote> {
    return this.remoteFiles;
  }

  async delete(path: string): Promise<void> {
    this.deletions.push(path);
    this.remoteFiles.delete(path);
  }

  constructor(
    initialFiles: Array<{
      path: string;
      contentBytes: ArrayBuffer;
      etag?: string;
      modified?: number;
    }> = [],
  ) {
    for (const file of initialFiles) {
      this.remoteFiles.set(file.path, {
        content: new Uint8Array(file.contentBytes),
        etag: file.etag ?? `${file.path}-etag`,
        modified: file.modified ?? this.nextModified(),
      });
    }
  }

  async listAll(_subPrefix?: string): Promise<RemoteFile[]> {
    return Array.from(this.remoteFiles.entries()).map(([path, file]) => ({
      path,
      etag: file.etag,
      modified: new Date(file.modified),
    }));
  }

  async download(path: string): Promise<ArrayBuffer> {
    const file = this.remoteFiles.get(path);
    assert.ok(file, `Missing remote file ${path}`);
    this.downloads.push(path);
    return file.content.buffer.slice(
      file.content.byteOffset,
      file.content.byteOffset + file.content.byteLength,
    );
  }

  async upload(path: string, content: ArrayBuffer): Promise<void> {
    const bytes = new Uint8Array(content);
    this.uploads.push(path);
    this.remoteFiles.set(path, {
      content: bytes,
      etag: `${path}-etag-${this.uploads.length}`,
      modified: this.nextModified(),
    });
  }

  private nextModified(): number {
    this.clock += 10;
    return this.clock;
  }
}

const mockSettings: S3SyncSettings = {
  bucket: "b",
  region: "us-east-1",
  accessKeyId: "a",
  secretAccessKey: "s",
  endpoint: "",
  prefix: "",
  autoSyncInterval: 5,
  passphrase: "test",
  stealthToken: "stealth",
  vaultSalt: "salt",
  liveSync: true,
  liveSyncDebounceMs: 1000,
  liveSyncPollingMs: 1000,
  conflictResolution: "local-wins",
  configConflictResolution: "remote-wins",
};

function createEngine(
  vault: FakeVault,
  s3: FakeS3Service,
  state: StateManager,
  onConflict: (path: string) => Promise<ConflictStrategy>,
): SyncEngine {
  return new SyncEngine(vault as never, s3 as never, state, mockSettings, onConflict, {
    trashFile: (file) => vault.trash(file, false),
  });
}

void test("sync downloads remote-only files without re-uploading them in the same run", async () => {
  const vault = new FakeVault();

  const aesKey = await CryptoUtils.deriveKey(mockSettings.passphrase, mockSettings.vaultSalt);
  const hmacKey = await CryptoUtils.deriveHmacKey(aesKey);
  const hmacPath = await CryptoUtils.hashPath("remote.md", hmacKey);
  const encryptedContent = await CryptoUtils.encryptBlob(
    "remote.md",
    new TextEncoder().encode("from-remote"),
    aesKey,
  );

  const s3 = new FakeS3Service([{ path: hmacPath, contentBytes: encryptedContent }]);
  const state = new StateManager();

  await createEngine(vault, s3, state, async () => "local-wins").sync();

  assert.equal(vault.readText("remote.md"), "from-remote");
  assert.deepEqual(s3.uploads, []);
  assert.deepEqual(s3.downloads, [hmacPath]);
  assert.equal(state.get("remote.md")?.path, "remote.md");
});

void test("sync uploads local-only files and refreshes state from remote metadata", async () => {
  const vault = new FakeVault([{ path: "local.md", content: "from-local", mtime: 25 }]);
  const s3 = new FakeS3Service();
  const state = new StateManager();

  const aesKey = await CryptoUtils.deriveKey(mockSettings.passphrase, mockSettings.vaultSalt);
  const hmacKey = await CryptoUtils.deriveHmacKey(aesKey);
  const hmacPath = await CryptoUtils.hashPath("local.md", hmacKey);

  await createEngine(vault, s3, state, async () => "local-wins").sync();

  assert.deepEqual(s3.uploads, [hmacPath]);
  assert.equal(state.get("local.md")?.path, "local.md");
  assert.ok((state.get("local.md")?.remoteMtime ?? 0) > 0);
});

void test("sync keeps local changes on conflict when local-wins is chosen", async () => {
  const vault = new FakeVault([{ path: "note.md", content: "local-new", mtime: 200 }]);

  const aesKey = await CryptoUtils.deriveKey(mockSettings.passphrase, mockSettings.vaultSalt);
  const hmacKey = await CryptoUtils.deriveHmacKey(aesKey);
  const hmacPath = await CryptoUtils.hashPath("note.md", hmacKey);
  const encryptedContent = await CryptoUtils.encryptBlob(
    "note.md",
    new TextEncoder().encode("remote-new"),
    aesKey,
  );

  const s3 = new FakeS3Service([
    { path: hmacPath, contentBytes: encryptedContent, etag: "remote-etag", modified: 900 },
  ]);
  const state = new StateManager();
  state.load([
    {
      path: "note.md",
      hmac: hmacPath,
      localMtime: 100,
      remoteMtime: 100,
      etag: "old-etag",
    },
  ]);

  await createEngine(vault, s3, state, async () => "local-wins").sync();

  assert.equal(vault.readText("note.md"), "local-new");
  assert.deepEqual(s3.downloads, []);
  assert.deepEqual(s3.uploads, [hmacPath]);
});

void test("sync replaces local content on conflict when remote-wins is chosen", async () => {
  const vault = new FakeVault([{ path: "note.md", content: "local-new", mtime: 200 }]);

  const aesKey = await CryptoUtils.deriveKey(mockSettings.passphrase, mockSettings.vaultSalt);
  const hmacKey = await CryptoUtils.deriveHmacKey(aesKey);
  const hmacPath = await CryptoUtils.hashPath("note.md", hmacKey);
  const encryptedContent = await CryptoUtils.encryptBlob(
    "note.md",
    new TextEncoder().encode("remote-new"),
    aesKey,
  );

  const s3 = new FakeS3Service([
    { path: hmacPath, contentBytes: encryptedContent, etag: "remote-etag", modified: 900 },
  ]);
  const state = new StateManager();
  state.load([
    {
      path: "note.md",
      hmac: hmacPath,
      localMtime: 100,
      remoteMtime: 100,
      etag: "old-etag",
    },
  ]);

  await createEngine(vault, s3, state, async () => "remote-wins").sync();

  assert.equal(vault.readText("note.md"), "remote-new");
  assert.deepEqual(s3.downloads, [hmacPath]);
  assert.deepEqual(s3.uploads, []);
});

void test("sync with create-copy conflict strategy", async () => {
  const vault = new FakeVault([{ path: "conflict.md", content: "local content", mtime: 200 }]);
  const state = new StateManager();
  const aesKey = await CryptoUtils.deriveKey(mockSettings.passphrase, mockSettings.vaultSalt);
  const hmacKey = await CryptoUtils.deriveHmacKey(aesKey);
  const hmac = await CryptoUtils.hashPath("conflict.md", hmacKey);
  const encrypted = await CryptoUtils.encryptBlob(
    "conflict.md",
    new TextEncoder().encode("remote content"),
    aesKey,
  );
  const s3 = new FakeS3Service([
    { path: hmac, contentBytes: encrypted, modified: 300, etag: "new" },
  ]);
  state.set("conflict.md", {
    path: "conflict.md",
    hmac,
    localMtime: 100,
    remoteMtime: 100,
    etag: "old",
  });
  await createEngine(vault, s3, state, async () => "create-copy").sync();
  assert.equal(vault.readText("conflict.md"), "local content", "Original file gets local content");
  const conflictCopyName = Array.from(vault.adapter.fs.keys()).find((path) =>
    path.startsWith("conflict (conflict "),
  );
  assert.ok(conflictCopyName, "Conflict copy should be created");
  assert.equal(
    vault.readText(conflictCopyName),
    "remote content",
    "Conflict copy gets remote content",
  );
});

void test("sync is idempotent", async () => {
  const vault = new FakeVault([{ path: "a.md", content: "a", mtime: 100 }]);
  const s3 = new FakeS3Service([]);
  const state = new StateManager();
  const engine = createEngine(vault, s3, state, async () => "local-wins");
  await engine.sync();
  assert.equal(s3.uploads.length, 1);
  s3.uploads = [];
  await engine.sync();
  assert.equal(s3.uploads.length, 0, "Second sync should not upload anything");
});

void test("createBackup and restoreLatestBackup round trip", async () => {
  const vault = new FakeVault([
    { path: "note.md", content: "hello world", mtime: 100 },
    { path: `${"." + "obsidian"}/app.json`, content: "{}", mtime: 100 },
  ]);
  const s3 = new FakeS3Service([]);
  const state = new StateManager();
  const engine = createEngine(vault, s3, state, async () => "local-wins");
  const backupPath = await engine.createBackup();
  assert.ok(backupPath.startsWith("_backups/snapshot-"));
  assert.equal(s3.files.size, 1);
  vault.adapter.fs.clear();
  const restoredPath = await engine.restoreLatestBackup();
  assert.equal(restoredPath, backupPath);
  assert.equal(vault.readText("note.md"), "hello world");
});

void test("CryptoUtils.decryptBlob processes valid blobs correctly", async () => {
  const aesKey = await CryptoUtils.deriveKey("pass", "salt");
  const validData = await CryptoUtils.encryptBlob(
    "test.md",
    new TextEncoder().encode("content"),
    aesKey,
  );
  const decrypted = await CryptoUtils.decryptBlob(validData, aesKey);
  assert.equal(decrypted.path, "test.md");
  assert.equal(new TextDecoder().decode(decrypted.content), "content");
});
