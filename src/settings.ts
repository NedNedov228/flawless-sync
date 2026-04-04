import type { FileState, S3SyncPluginData, S3SyncSettings } from "./types";

export const DEFAULT_SETTINGS: S3SyncSettings = {
  bucket: "",
  region: "us-east-1",
  accessKeyId: "",
  secretAccessKey: "",
  endpoint: "",
  prefix: "obsidian-vault",
  autoSyncInterval: 5,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(
  source: Record<string, unknown>,
  key: keyof S3SyncSettings,
  fallback: string,
): string {
  const value = source[key];
  return typeof value === "string" ? value : fallback;
}

function readNumber(
  source: Record<string, unknown>,
  key: keyof S3SyncSettings,
  fallback: number,
): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeSettings(source: Record<string, unknown>): S3SyncSettings {
  // Trim and clamp persisted values so broken or partial saved data does not poison the runtime config.
  return {
    bucket: readString(source, "bucket", DEFAULT_SETTINGS.bucket).trim(),
    region: readString(source, "region", DEFAULT_SETTINGS.region).trim() || DEFAULT_SETTINGS.region,
    accessKeyId: readString(source, "accessKeyId", DEFAULT_SETTINGS.accessKeyId).trim(),
    secretAccessKey: readString(source, "secretAccessKey", DEFAULT_SETTINGS.secretAccessKey).trim(),
    endpoint: readString(source, "endpoint", DEFAULT_SETTINGS.endpoint).trim(),
    prefix: readString(source, "prefix", DEFAULT_SETTINGS.prefix).trim(),
    autoSyncInterval: Math.max(
      0,
      readNumber(source, "autoSyncInterval", DEFAULT_SETTINGS.autoSyncInterval),
    ),
  };
}

function normalizeFileStates(raw: unknown): FileState[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const fileStates: FileState[] = [];

  for (const item of raw) {
    if (!isRecord(item) || typeof item.path !== "string") {
      continue;
    }

    fileStates.push({
      path: item.path,
      localMtime:
        typeof item.localMtime === "number" && Number.isFinite(item.localMtime)
          ? item.localMtime
          : 0,
      remoteMtime:
        typeof item.remoteMtime === "number" && Number.isFinite(item.remoteMtime)
          ? item.remoteMtime
          : 0,
      etag: typeof item.etag === "string" ? item.etag : "",
    });
  }

  return fileStates;
}

export function normalizePluginData(raw: unknown): S3SyncPluginData {
  const data = isRecord(raw) ? raw : {};
  // Support both the current nested shape and the older flat settings shape during upgrades.
  const settingsSource = isRecord(data.settings) ? data.settings : data;

  return {
    settings: normalizeSettings(settingsSource),
    fileStates: normalizeFileStates(data.fileStates),
  };
}
