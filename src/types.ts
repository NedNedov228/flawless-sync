export type ConflictStrategy = "local-wins" | "remote-wins" | "create-copy";

export interface S3SyncSettings {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  prefix: string;
  autoSyncInterval: number;
  passphrase: string;
  stealthToken: string;
  vaultSalt: string;
  liveSync: boolean;
  liveSyncDebounceMs: number;
  liveSyncPollingMs: number;
  conflictResolution: "local-wins" | "remote-wins" | "create-copy";
  configConflictResolution: "local-wins" | "remote-wins" | "create-copy";
  instanceId?: string;
}

export interface FileState {
  path: string;
  hmac: string;
  localMtime: number;
  remoteMtime: number;
  etag: string;
}

export interface S3SyncPluginData {
  settings: S3SyncSettings;
  fileStates: FileState[];
}

/** Derived encryption keys plus the inputs they were derived from, used as a cache key. */
export interface DerivedKeys {
  aesKey: CryptoKey;
  hmacKey: CryptoKey;
  passphrase?: string;
  vaultSalt?: string;
}

/** The slice of the plugin the sync engine needs to reuse derived keys across runs. */
export interface KeyCacheHost {
  getCachedKeys(): DerivedKeys | null;
  setCachedKeys(keys: DerivedKeys | null): void;
}

/** Minimal shape shared by `TFile` and the config-folder entries discovered through the adapter. */
export interface LocalFileEntry {
  path: string;
  stat: {
    mtime: number;
  };
}

export interface LocalFileOptions {
  syncConfig: boolean;
  syncNotes: boolean;
}
