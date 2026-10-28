# Flawless Sync (S3) for Obsidian

## 1. Introduction

**Flawless Sync** is an advanced, privacy-first synchronization plugin for Obsidian. It provides continuous, conflict-aware, and End-to-End Encrypted (E2EE) synchronization of Obsidian vaults using Amazon S3 (or any S3-compatible storage like Cloudflare R2, MinIO, or Backblaze B2).

The core philosophy of this plugin is to ensure absolute data privacy and robust conflict resolution without relying on proprietary or third-party intermediary servers. The user remains in complete control of their data and infrastructure.

## 2. Key Features

- **End-to-End Encryption (E2EE):** All file contents and filenames are encrypted client-side before ever leaving your device using AES-256-GCM and HMAC-SHA256. The cloud provider only sees obfuscated hashes and encrypted blobs.
- **Event-Driven Live Sync:** Automatically pushes and pulls changes in real-time as you type, driven by Obsidian's internal `Vault` event bus.
- **Conflict Resolution:** Built-in strategies for resolving synchronization conflicts (`local-wins`, `remote-wins`, or safely preserving both via `create-copy`).
- **Complete Vault Backups:** Dedicated snapshot functionality to bundle the entire vault into a secure, point-in-time encrypted JSON backup, which can be restored instantly.
- **Config Sync:** Safely synchronizes `.obsidian` configuration files (snippets, themes, plugins) on demand without causing cyclic crash loops.
- **Mobile Compatible:** Strictly relies on Obsidian's internal API (`requestUrl`) for network operations, bypassing browser CORS restrictions entirely and guaranteeing execution on both Desktop and Mobile (iOS/Android).

## 3. Project Structure

The codebase is split into well-defined modules with clear boundaries:

```text
src/
 ├── main.ts            // Entry point: Plugin lifecycle, Event listeners, Auto/Live-sync scheduling
 ├── syncEngine.ts      // Core logic: The synchronization loop, conflict resolution, diff calculation
 ├── crypto.ts          // Security: PBKDF2 key derivation, AES-GCM encryption, HMAC hashing
 ├── s3Client.ts        // Networking: AWS SDK integration wrapped around Obsidian's requestUrl
 ├── stateManager.ts    // State tracking: Maintains local cache of ETag & modified timestamps
 ├── settings.ts        // Constants: Default settings definitions
 ├── settingsTab.ts     // UI: The Obsidian plugin settings pane
 ├── errors.ts          // Helpers: Safe formatting of unknown thrown values
 └── types.ts           // Types: Shared TypeScript interfaces
scripts/                // Build/test tooling, incl. the `obsidian` module stub for tests
tests/                  // Comprehensive unit tests covering syncing behaviors and crypto
```

## 4. Getting Started

### Prerequisites
- Node.js 18+ and npm
- An Obsidian Vault

### Installation & Development
1. Clone the repository into `<Vault>/.obsidian/plugins/flaweless-sync-s3/`.
2. Run `npm install` to fetch dependencies.
3. Run `npm run dev` for watch-mode compilation during development.
4. Run `npm run build` to generate the production `main.js`.
5. Run `npm test` to execute the automated test suite.

---
*Next:* Read [Architecture](./02-architecture.md) for a deeper understanding of how the components interact.
