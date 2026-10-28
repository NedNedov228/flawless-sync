# Architecture

## 1. System Design

The plugin operates as a state-based synchronization engine. It does not rely on a central database; instead, S3 acts as the absolute source of truth (the remote state), and the local Obsidian Vault acts as the local state. A metadata cache (`StateManager`) bridges the two.

```mermaid
graph TD
    A[Obsidian Vault] <-->|Read / Write| B(Sync Engine)
    C[Vault EventBus] -->|Modify/Delete triggers| D{Live Sync Debouncer}
    D -->|Initiates Sync| B
    B <-->|Encrypts/Decrypts| E(Crypto Utils)
    B <-->|Checks metadata| F[(State Manager)]
    B <-->|AWS SDK Commands| G(S3 Client)
    G <-->|requestUrl (Bypasses CORS)| H((Amazon S3))
```

## 2. Bypassing CORS Constraints

One of the largest challenges when writing an Obsidian plugin that communicates with S3 is Cross-Origin Resource Sharing (CORS). Standard browser-based `fetch` requests initiated by Obsidian (an Electron/Capacitor wrapper) will often be blocked by S3 unless the bucket's CORS policy is explicitly configured to allow `app://obsidian.md` or similar origins.

To ensure the plugin works identically across all devices (Desktop, iOS, Android) without requiring complex bucket configurations, **Flawless Sync intercepts AWS SDK HTTP requests and routes them through Obsidian's native `requestUrl`**.

### The Smithy RequestHandler Override
In `s3Client.ts`, we inject a custom `RequestHandler` into the AWS S3 Client initialization:

```typescript
import { S3Client } from "@aws-sdk/client-s3";
import { requestUrl } from "obsidian";

const client = new S3Client({
  // ... credentials and region ...
  requestHandler: {
    handle: async (request: any) => {
      // Convert AWS SDK request format to Obsidian's requestUrl format
      const response = await requestUrl({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        throw: false
      });
      
      // Map it back to a Smithy/AWS SDK compatible HttpResponse
      return { response: mappedResponse };
    }
  }
});
```
This forces all S3 traffic out of the web view and into the native OS networking stack, making the plugin entirely resilient to CORS issues.

## 3. The State Manager

To minimize S3 API requests and bandwidth, the plugin must track which files it has already synced. `StateManager` (`src/stateManager.ts`) handles this.

It saves a local JSON dictionary mapped by file paths:
```json
{
  "Notes/Ideas.md": {
    "path": "Notes/Ideas.md",
    "hmac": "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
    "localMtime": 1700000000,
    "remoteMtime": 1700000000,
    "etag": "\"some-s3-etag\""
  }
}
```
When calculating differences during a sync, the Engine compares the Vault's current modified times and S3's current ETags against this cached state.

---
*Next:* Read [The Sync Engine](./03-sync-engine.md) for details on the synchronization logic.
