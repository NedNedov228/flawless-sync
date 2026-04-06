# Flaweless Sync (BETA)

Sync your Obsidian vault with Amazon S3 and S3-compatible storage such as Cloudflare R2, MinIO, and Backblaze B2.

## Overview

Flaweless Sync AWS/S3 is an Obsidian community plugin focused on simple bucket-based sync.
It stores your vault files inside an S3 bucket or bucket prefix and provides:

- Manual sync from the ribbon or command palette
- Background sync with a configurable interval
- Support for S3-compatible endpoints
- Local settings storage inside Obsidian plugin data
- Connection testing from the settings tab

## Supported storage

- Amazon S3
- Cloudflare R2
- MinIO
- Backblaze B2 S3-compatible API
- Other S3-compatible providers

## Features

- Sync vault files to remote storage
- Download remote files that do not exist locally
- Detect changed files using local metadata and remote object metadata
- Keep all files inside a configurable bucket prefix
- Test storage connection directly from plugin settings

## Configuration

Open the plugin settings and fill in:

- `Bucket`: your target bucket name
- `Region`: AWS region or provider region
- `Access key ID`: access key for the storage account
- `Secret access key`: secret key for the storage account
- `Custom endpoint`: required for providers like Cloudflare R2, MinIO, or Backblaze B2
- `Prefix`: folder inside the bucket where vault files will be stored
- `Auto-sync interval`: sync interval in minutes, `0` disables background sync

After that, use **Test connection** to verify the setup.

## Cloudflare R2 example

Example values for R2:

- `Bucket`: `my-vault`
- `Region`: `auto`
- `Custom endpoint`: `https://<account-id>.r2.cloudflarestorage.com`
- `Prefix`: `obsidian-vault`

## How to use

### Manual sync

- Click the sync ribbon icon
- Or run `Sync vault with S3` from the command palette

### Background sync

Set `Auto-sync interval` in plugin settings.

- `0`: disabled
- `5`: sync every 5 minutes
- `15`: sync every 15 minutes

## Recommended test flow

1. Configure the plugin and press **Test connection**.
2. Create a new note in your vault.
3. Run a manual sync.
4. Check that the file appears in your bucket under the configured prefix.
5. Edit the note locally and sync again.
6. Verify that the remote object updates.
7. Add or change a file remotely and test that it downloads back into the vault.

## Installation

### Manual install

1. Build the plugin:

```bash
npm install
npm run build
```

2. Copy these files into your vault plugin directory:

- `main.js`
- `manifest.json`
- `styles.css`

Target directory:

```text
<Vault>/.obsidian/plugins/flaweless-sync-aws/
```

3. Open Obsidian and go to **Settings → Community plugins**.
4. Enable the plugin.



## Development

### Requirements

- Node.js 18+
- npm

### Commands

Install dependencies:

```bash
npm install
```

Start watch mode:

```bash
npm run dev
```

Production build:

```bash
npm run build
```

Lint:

```bash
npm run lint
```

## Project structure

```text
src/
  main.ts         Plugin lifecycle and sync orchestration
  settings.ts     Default settings and stored data normalization
  settingsTab.ts  Obsidian settings UI
  s3Client.ts     S3 and S3-compatible client layer
  stateManager.ts Local sync state storage
  syncEngine.ts   Upload and download sync logic
  types.ts        Shared TypeScript types
```

## Notes

- The plugin is currently focused on simple direct sync workflows.
- It uses Obsidian's networking layer for compatibility with providers such as Cloudflare R2.
- Settings and sync metadata are stored locally using Obsidian plugin data.

## Known limitations

- Conflict handling is currently basic and defaults to keeping the local version.
- Sync state is metadata-based and not yet a full bidirectional merge engine.
- Very large vaults may need additional optimization in future versions.

## Release files

For release builds, include:

- `main.js`
- `manifest.json`
- `styles.css`

## License

`MIT`
