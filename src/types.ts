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
