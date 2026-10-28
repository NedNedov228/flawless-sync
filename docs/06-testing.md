# Testing and Automation

Because Flawless Sync operates on user data and performs potentially destructive conflict resolution (overwriting files), high-quality test coverage is absolutely critical.

## 1. The Test Suite

The plugin uses the native Node.js Test Runner (`node --test`) along with strict TypeScript checking. 

### Why the custom `run-tests.mjs` script?
Obsidian plugins are inherently bound to the `obsidian` module, which is injected at runtime inside the Obsidian desktop/mobile app. When running tests in a pure Node.js environment, `import { requestUrl } from "obsidian"` throws a fatal `Module not found` error.

To solve this, we use a custom script (`scripts/run-tests.mjs`) that intercepts the Node module loader and injects a mock `obsidian` module into the environment before tests execute.

```javascript
// From scripts/run-tests.mjs — the real stub lives in scripts/obsidian-stub.cjs
const m = require('module');
const orig = m._load;
const stub = require('<project>/scripts/obsidian-stub.cjs');

m._load = function (request, parent, isMain) {
  if (request === 'obsidian') return stub;
  return orig.apply(this, arguments);
};
```

The stub exposes `TAbstractFile`, `TFile`, `TFolder` and `requestUrl`. The file classes
matter because `SyncEngine` narrows vault entries with `instanceof TFile` instead of a
`TFile` cast, so the mocks must be real class instances.

## 2. Test Execution
Tests are run against the compiled `.test-dist` output directory to avoid TypeScript execution overhead during the run.

```bash
npm run test
```

## 3. Mocking Dependencies
In `tests/syncEngine.test.ts`, we implement robust mocks for the Obsidian Vault and S3 Service:

- `FakeVault`: Simulates an in-memory file system mimicking Obsidian's API (`readText`, `readBinary`, `modifyBinary`, `getAbstractFileByPath`). It increments an internal clock to simulate file modification timestamps (`mtime`).
- `FakeS3Service`: Simulates an S3 bucket tracking uploads, downloads, deletions, and ETags.

By decoupling `SyncEngine` from the real `app.vault` and AWS SDK, we can simulate complex scenarios like "create-copy" conflict resolution, idempotent syncs (zero uploads when unchanged), and "Eventual Consistency" lags in milliseconds.
