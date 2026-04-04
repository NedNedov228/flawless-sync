import { test } from "node:test";
import { strict as assert } from "node:assert";
import { StateManager } from "../src/stateManager";
import { SyncEngine } from "../src/syncEngine";
import type { ConflictStrategy } from "../src/syncEngine";
import type { RemoteFile } from "../src/s3Client";

type VaultFile = {
  path: string;
  stat: {
    mtime: number;
  };
};

class FakeVault {
  private files = new Map<string, { content: Uint8Array; mtime: number }>();
  private clock = 100;

  constructor(initialFiles: Array<{ path: string; content: string; mtime?: number }> = []) {
    for (const file of initialFiles) {
      this.files.set(file.path, {
        content: this.toBytes(file.content),
        mtime: file.mtime ?? this.nextMtime(),
      });
    }
  }

  getFiles(): VaultFile[] {
    return Array.from(this.files.entries()).map(([path, file]) => ({
      path,
      stat: { mtime: file.mtime },
    }));
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

  private nextMtime(): number {
    this.clock += 1;
    return this.clock;
  }

  private toBytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
  }
}

class FakeS3Service {
  private remoteFiles = new Map<
    string,
    { content: Uint8Array; etag: string; modified: number }
  >();
  private clock = 500;
  uploads: string[] = [];
  downloads: string[] = [];

  constructor(
    initialFiles: Array<{ path: string; content: string; etag?: string; modified?: number }> = [],
  ) {
    for (const file of initialFiles) {
      this.remoteFiles.set(file.path, {
        content: new TextEncoder().encode(file.content),
        etag: file.etag ?? `${file.path}-etag`,
        modified: file.modified ?? this.nextModified(),
      });
    }
  }

  async listAll(): Promise<RemoteFile[]> {
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
    return file.content.buffer.slice(file.content.byteOffset, file.content.byteOffset + file.content.byteLength);
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

  readText(path: string): string | undefined {
    const file = this.remoteFiles.get(path);
    return file ? new TextDecoder().decode(file.content) : undefined;
  }

  private nextModified(): number {
    this.clock += 10;
    return this.clock;
  }
}

function createEngine(
  vault: FakeVault,
  s3: FakeS3Service,
  state: StateManager,
  onConflict: (path: string) => Promise<ConflictStrategy>,
): SyncEngine {
  return new SyncEngine(vault as never, s3 as never, state, onConflict);
}

void test("sync downloads remote-only files without re-uploading them in the same run", async () => {
  const vault = new FakeVault();
  const s3 = new FakeS3Service([{ path: "remote.md", content: "from-remote" }]);
  const state = new StateManager();

  await createEngine(vault, s3, state, async () => "local-wins").sync();

  assert.equal(vault.readText("remote.md"), "from-remote");
  assert.deepEqual(s3.uploads, []);
  assert.deepEqual(s3.downloads, ["remote.md"]);
  assert.equal(state.get("remote.md")?.path, "remote.md");
});

void test("sync uploads local-only files and refreshes state from remote metadata", async () => {
  const vault = new FakeVault([{ path: "local.md", content: "from-local", mtime: 25 }]);
  const s3 = new FakeS3Service();
  const state = new StateManager();

  await createEngine(vault, s3, state, async () => "local-wins").sync();

  assert.deepEqual(s3.uploads, ["local.md"]);
  assert.equal(s3.readText("local.md"), "from-local");
  assert.equal(state.get("local.md")?.path, "local.md");
  assert.ok((state.get("local.md")?.remoteMtime ?? 0) > 0);
});

void test("sync keeps local changes on conflict when local-wins is chosen", async () => {
  const vault = new FakeVault([{ path: "note.md", content: "local-new", mtime: 200 }]);
  const s3 = new FakeS3Service([
    { path: "note.md", content: "remote-new", etag: "remote-etag", modified: 900 },
  ]);
  const state = new StateManager();
  state.load([
    {
      path: "note.md",
      localMtime: 100,
      remoteMtime: 100,
      etag: "old-etag",
    },
  ]);

  await createEngine(vault, s3, state, async () => "local-wins").sync();

  assert.equal(vault.readText("note.md"), "local-new");
  assert.equal(s3.readText("note.md"), "local-new");
  assert.deepEqual(s3.downloads, []);
  assert.deepEqual(s3.uploads, ["note.md"]);
});

void test("sync replaces local content on conflict when remote-wins is chosen", async () => {
  const vault = new FakeVault([{ path: "note.md", content: "local-new", mtime: 200 }]);
  const s3 = new FakeS3Service([
    { path: "note.md", content: "remote-new", etag: "remote-etag", modified: 900 },
  ]);
  const state = new StateManager();
  state.load([
    {
      path: "note.md",
      localMtime: 100,
      remoteMtime: 100,
      etag: "old-etag",
    },
  ]);

  await createEngine(vault, s3, state, async () => "remote-wins").sync();

  assert.equal(vault.readText("note.md"), "remote-new");
  assert.equal(s3.readText("note.md"), "remote-new");
  assert.deepEqual(s3.downloads, ["note.md"]);
  assert.deepEqual(s3.uploads, []);
});
