# The Sync Engine

The `SyncEngine` (`src/syncEngine.ts`) is the heart of the plugin. It calculates differences, detects conflicts, and orchestrates uploads and downloads.

## 1. The Synchronization Loop

The sync process is completely bidirectional but operates sequentially to prevent race conditions:

1. **State Gathering:**
   - Retrieve all local files from the Vault (filtering out ignored folders like `.git` and `node_modules`).
   - Retrieve all remote files (objects) from the target S3 prefix.
2. **Key Derivation:**
   - Derive the AES-GCM and HMAC keys from the user's passphrase.
3. **Download Phase:**
   - Iterate over the remote files.
   - For each file, check if it exists locally. 
   - If missing locally: Download, decrypt, and save.
   - If it exists locally: Compare ETags and Modified times against the `StateManager`.
   - **Conflict Handling:** If both the remote and local files were modified since the last sync, invoke the conflict resolution strategy.
4. **Upload Phase:**
   - Iterate over the local files.
   - If a local file is missing remotely, or its `mtime` is strictly newer than the last known `localMtime`, encrypt and upload it.
   - **Eventual Consistency:** In-flight uploads immediately update the `StateManager` locally so that subsequent quick-syncs don't double-upload the same file while S3 reflects the new metadata.

## 2. Conflict Resolution Strategies

When the engine detects that a file has diverged (both the local Vault version and the S3 version were modified independently), it delegates to the user's configured strategy:

- **`local-wins`:** The local file's content is considered authoritative. The remote file is forcefully overwritten.
- **`remote-wins`:** The remote file's content is authoritative. The local file is forcefully overwritten.
- **`create-copy`:** The safest strategy. The local modifications are preserved in a new file named `filename (conflict 1700000000).md`. The original filename receives the remote updates. This matches the behavior of typical cloud drives (like Google Drive or Dropbox).

```typescript
// From syncEngine.ts - Conflict Handling
if (conflictStrategy === "create-copy") {
  const extIndex = local.path.lastIndexOf(".");
  const base = extIndex !== -1 ? local.path.substring(0, extIndex) : local.path;
  const ext = extIndex !== -1 ? local.path.substring(extIndex) : "";
  const conflictPath = `${base} (conflict ${Date.now()})${ext}`;

  const encryptedContent = await this.s3.download(hmac);
  const { content } = await CryptoUtils.decryptBlob(encryptedContent, keys.aesKey);

  await this.safeWriteFile(conflictPath, content); // Save the conflict copy
}
```

## 3. Config Syncing

Syncing Obsidian configuration (`.obsidian/` folder) during a standard Markdown sync is highly dangerous. Changing themes or plugins dynamically can crash the app.
Therefore, config syncing is manually invoked via command (`pushConfig` and `pullConfig`). 

The configuration is bundled into a `_config.json` manifest that maps paths to their corresponding encrypted blob HMACs inside `_config_files/`. Old, stale config files are automatically purged by `pushConfig` by comparing S3 contents against the new manifest.

---
*Next:* Read [Cryptography](./04-cryptography.md) for details on security.
