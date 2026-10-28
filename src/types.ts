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
