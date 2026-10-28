# Cryptography and Security

Flawless Sync takes a zero-trust approach to data storage. Amazon S3 (or your chosen provider) should never be able to read your notes or even deduce the directory structure or file names of your vault.

All cryptographic operations use standard native WebCrypto APIs (`window.crypto.subtle`), ensuring high performance on both Desktop and Mobile without reliance on heavy WebAssembly modules.

## 1. Key Derivation

When a sync starts, the engine derives two separate keys from the user's master passphrase:
1. **AES Key:** Used for encrypting and decrypting file contents and paths.
2. **HMAC Key:** Used for obfuscating filenames.

```typescript
// PBKDF2 derivation with 100,000 iterations
const baseKey = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(passphrase),
  { name: "PBKDF2" },
  false,
  ["deriveKey"]
);

const aesKey = await crypto.subtle.deriveKey(
  {
    name: "PBKDF2",
    salt: new TextEncoder().encode(vaultSalt),
    iterations: 100000,
    hash: "SHA-256",
  },
  baseKey,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt", "decrypt"]
);
```

## 2. File Name Obfuscation

To hide folder structures and file names, every file path is hashed using HMAC-SHA256, encoded into a Hex string. 

```typescript
// Hash "Notes/Secret.md" -> "a94a8fe5ccb19ba6..."
const hmacKey = await CryptoUtils.deriveHmacKey(aesKey);
const hmac = await CryptoUtils.hashPath(file.path, hmacKey);
```

On S3, all files are stored completely flat inside the root prefix (e.g., `flawless-sync-vault/a94a8...`). There are no folders on S3.

## 3. Data Encryption (AES-GCM)

Since S3 only sees a hashed path, how do we know the original filename when downloading a file on a new device?
We prepend the plaintext length of the original path, the encrypted path, and the Initialization Vector (IV) to the encrypted file content.

The blob structure uploaded to S3 is:
`[1 byte: Path Length] + [12 bytes: IV] + [Encrypted Path] + [Encrypted Content]`

### Defending Against Memory Corruption
A critical vulnerability check ensures that the `pathLength` is properly validated during decryption. Without this check, a maliciously tampered path length could cause the algorithm to slice out of bounds, resulting in memory corruption or a crash loop when syncing.

```typescript
// From crypto.ts - Validation check
const pathLength = encryptedBlob[0];
if (1 + 12 + pathLength > encryptedBlob.length) {
  throw new Error("Invalid encrypted blob: path length exceeds payload size.");
}
```

Because AES-GCM includes an authentication tag, any tampering with the contents of the blob (including the IV, path, or content) will cause `crypto.subtle.decrypt` to instantly fail and reject the promise, ensuring absolute data integrity.
