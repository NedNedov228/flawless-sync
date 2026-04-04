import { test } from "node:test";
import { strict as assert } from "node:assert";
import { DEFAULT_SETTINGS, normalizePluginData } from "../src/settings";

void test("normalizePluginData returns defaults for missing data", () => {
  const result = normalizePluginData(undefined);

  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
  assert.deepEqual(result.fileStates, []);
});

void test("normalizePluginData supports legacy flat settings shape", () => {
  const result = normalizePluginData({
    bucket: "  my-bucket  ",
    region: "",
    accessKeyId: "  key  ",
    secretAccessKey: "  secret  ",
    endpoint: "  https://example.com  ",
    prefix: "  my-prefix  ",
    autoSyncInterval: -10,
  });

  assert.deepEqual(result.settings, {
    bucket: "my-bucket",
    region: DEFAULT_SETTINGS.region,
    accessKeyId: "key",
    secretAccessKey: "secret",
    endpoint: "https://example.com",
    prefix: "my-prefix",
    autoSyncInterval: 0,
  });
  assert.deepEqual(result.fileStates, []);
});

void test("normalizePluginData filters invalid file states and keeps valid entries", () => {
  const result = normalizePluginData({
    settings: {
      bucket: "vault",
      autoSyncInterval: 15,
    },
    fileStates: [
      {
        path: "note.md",
        localMtime: 10,
        remoteMtime: 20,
        etag: "etag-1",
      },
      {
        path: 123,
        localMtime: "bad",
      },
      {
        path: "broken.md",
      },
    ],
  });

  assert.equal(result.settings.bucket, "vault");
  assert.equal(result.settings.autoSyncInterval, 15);
  assert.deepEqual(result.fileStates, [
    {
      path: "note.md",
      localMtime: 10,
      remoteMtime: 20,
      etag: "etag-1",
    },
    {
      path: "broken.md",
      localMtime: 0,
      remoteMtime: 0,
      etag: "",
    },
  ]);
});
