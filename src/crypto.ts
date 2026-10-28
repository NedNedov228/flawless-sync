export class CryptoUtils {
  static async generateSalt(): Promise<string> {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    return this.bufferToBase64(salt);
  }

  static async deriveKey(passphrase: string, saltBase64: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      { name: "PBKDF2" },
      false,
      ["deriveBits", "deriveKey"],
    );

    const salt = this.base64ToBuffer(saltBase64);

    return window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: 250000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      true, // extractable because we might need it for HMAC which requires different algorithm
      ["encrypt", "decrypt"],
    );
  }

  // We need an HMAC key to hash the path deterministically. 
  // We can derive it from the same PBKDF2 but with a different salt, or just import the raw bits of the AES key.
  static async deriveHmacKey(aesKey: CryptoKey): Promise<CryptoKey> {
    const rawKey = await window.crypto.subtle.exportKey("raw", aesKey);
    return window.crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }

  static async hashPath(path: string, hmacKey: CryptoKey): Promise<string> {
    const enc = new TextEncoder();
    const signature = await window.crypto.subtle.sign(
      "HMAC",
      hmacKey,
      enc.encode(path),
    );
    return this.bufferToHex(signature);
  }

  static async encryptBlob(
    path: string,
    content: ArrayBuffer,
    aesKey: CryptoKey,
  ): Promise<ArrayBuffer> {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const pathBytes = enc.encode(path);

    if (pathBytes.length > 65535) {
      throw new Error("Path is too long");
    }

    const payload = new Uint8Array(2 + pathBytes.length + content.byteLength);
    // 2 bytes for path length
    payload[0] = (pathBytes.length >> 8) & 0xff;
    payload[1] = pathBytes.length & 0xff;
    // path
    payload.set(pathBytes, 2);
    // content
    payload.set(new Uint8Array(content), 2 + pathBytes.length);

    const ciphertext = await window.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
      },
      aesKey,
      payload,
    );

    // Final blob: [12 bytes IV] + [Ciphertext (includes GCM auth tag)]
    const result = new Uint8Array(12 + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), 12);
    return result.buffer;
  }

  static async decryptBlob(
    encrypted: ArrayBuffer,
    aesKey: CryptoKey,
  ): Promise<{ path: string; content: ArrayBuffer }> {
    if (encrypted.byteLength < 12) {
      throw new Error("Invalid encrypted blob");
    }

    const encryptedBytes = new Uint8Array(encrypted);
    const iv = encryptedBytes.slice(0, 12);
    const ciphertext = encryptedBytes.slice(12);

    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
      },
      aesKey,
      ciphertext,
    );

    const decryptedBytes = new Uint8Array(decrypted);
    if (decryptedBytes.length < 2) {
      throw new Error("Decrypted blob is too short to contain a path length header.");
    }
    const pathLength = (decryptedBytes[0]! << 8) | decryptedBytes[1]!;
    if (pathLength === 0 || 2 + pathLength > decryptedBytes.length) {
      throw new Error(`Invalid path length ${pathLength} in decrypted blob (total size: ${decryptedBytes.length}).`);
    }
    
    const pathBytes = decryptedBytes.slice(2, 2 + pathLength);
    const contentBytes = decryptedBytes.slice(2 + pathLength);

    const dec = new TextDecoder();
    return {
      path: dec.decode(pathBytes),
      content: contentBytes.buffer.slice(
        contentBytes.byteOffset,
        contentBytes.byteOffset + contentBytes.byteLength,
      ),
    };
  }

  static bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return window.btoa(binary);
  }

  static base64ToBuffer(base64: string): Uint8Array {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private static bufferToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
