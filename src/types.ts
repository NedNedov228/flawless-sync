export interface S3SyncSettings {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  prefix: string;
  autoSyncInterval: number;
}

export interface FileState {
  path: string;
  localMtime: number;
  remoteMtime: number;
  etag: string;
}

export interface S3SyncPluginData {
  settings: S3SyncSettings;
  fileStates: FileState[];
}
