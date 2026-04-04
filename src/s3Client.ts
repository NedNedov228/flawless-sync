import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  HttpHandlerOptions,
  HttpRequest,
  HttpResponse,
  RequestHandler,
} from "@smithy/types";
import { requestUrl } from "obsidian";
import type { S3SyncSettings } from "./types";

export interface RemoteFile {
  path: string;
  etag: string;
  modified: Date;
}

// Remotely Save uses the same idea: route S3 traffic through Obsidian's requestUrl layer
// to avoid browser-origin CORS restrictions while still keeping AWS request signing in the SDK.
class ObsidianRequestUrlHandler
  implements RequestHandler<HttpRequest, HttpResponse, HttpHandlerOptions>
{
  async handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    const protocol = request.protocol ?? "https:";
    const path = request.path.startsWith("/") ? request.path : `/${request.path}`;
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value) {
          searchParams.append(key, item);
        }
        continue;
      }

      if (value === null || value === undefined) {
        searchParams.append(key, "");
        continue;
      }

      searchParams.append(key, String(value));
    }

    const query = searchParams.toString();
    const url = `${protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}${path}${query ? `?${query}` : ""}`;

    // requestUrl accepts only a small subset of body types, so normalize Smithy request bodies first.
    const body = this.normalizeBody(request.body);
    const response = await requestUrl({
      url,
      method: request.method,
      headers: this.normalizeHeaders(request.headers ?? {}),
      body,
      throw: false,
    });

    return {
      response: {
        statusCode: response.status,
        headers: response.headers,
        body: this.toReadableStream(response.arrayBuffer),
      },
    };
  }

  destroy(): void {}

  private toReadableStream(buffer: ArrayBuffer): ReadableStream<Uint8Array> {
    // The AWS deserializer expects a stream-like body on the browser path, not a raw Uint8Array.
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      },
    });
  }

  private normalizeHeaders(headers: Record<string, string>): Record<string, string> {
    const normalizedHeaders: Record<string, string> = {};
    const blockedHeaders = new Set([
      "content-length",
      "host",
    ]);

    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) {
        continue;
      }

      const normalizedKey = key.toLowerCase();
      // Electron rejects some transport-managed headers when they are passed through manually.
      if (blockedHeaders.has(normalizedKey)) {
        continue;
      }

      normalizedHeaders[normalizedKey] = value;
    }

    return normalizedHeaders;
  }

  private normalizeBody(body: HttpRequest["body"]): string | ArrayBuffer | undefined {
    if (body === undefined || body === null) {
      return undefined;
    }

    if (typeof body === "string" || body instanceof ArrayBuffer) {
      return body;
    }

    if (ArrayBuffer.isView(body)) {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    }

    return undefined;
  }
}

type S3Config = Pick<
  S3SyncSettings,
  "bucket" | "region" | "accessKeyId" | "secretAccessKey" | "endpoint" | "prefix"
>;

export class S3Service {
  private client: S3Client;
  private config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      endpoint: config.endpoint || undefined,
      forcePathStyle: Boolean(config.endpoint),
      requestHandler: new ObsidianRequestUrlHandler(),
    });
  }

  private normalizePrefix(): string {
    // Normalizing once avoids subtle key mismatches caused by leading/trailing slashes in settings.
    return this.config.prefix.trim().replace(/^\/+|\/+$/g, "");
  }

  private key(path: string): string {
    const normalizedPrefix = this.normalizePrefix();
    const prefix = normalizedPrefix ? `${normalizedPrefix}/` : "";
    return `${prefix}${path}`;
  }

  async upload(path: string, content: ArrayBuffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(path),
        Body: new Uint8Array(content),
      }),
    );
  }

  async download(path: string): Promise<ArrayBuffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(path),
      }),
    );

    if (!response.Body) {
      throw new Error(`S3 object "${path}" has no response body.`);
    }

    // Depending on the runtime path inside Smithy, the body can arrive in several compatible shapes.
    if (response.Body instanceof Uint8Array) {
      return response.Body.buffer.slice(
        response.Body.byteOffset,
        response.Body.byteOffset + response.Body.byteLength,
      );
    }

    if (response.Body instanceof ArrayBuffer) {
      return response.Body;
    }

    if (
      typeof response.Body === "object" &&
      response.Body !== null &&
      "transformToByteArray" in response.Body &&
      typeof response.Body.transformToByteArray === "function"
    ) {
      const bytes = await response.Body.transformToByteArray();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    throw new Error(`Unsupported S3 response body type for "${path}".`);
  }

  async testConnection(): Promise<void> {
    const prefix = this.normalizePrefix();

    await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: prefix ? `${prefix}/` : undefined,
        MaxKeys: 1,
      }),
    );
  }

  async listAll(): Promise<RemoteFile[]> {
    const results: RemoteFile[] = [];
    const prefix = this.normalizePrefix();
    const prefixedPath = prefix ? `${prefix}/` : "";
    let token: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefixedPath || undefined,
          ContinuationToken: token,
        }),
      );

      for (const object of response.Contents ?? []) {
        if (!object.Key) {
          continue;
        }

        const path =
          prefixedPath && object.Key.startsWith(prefixedPath)
            ? object.Key.slice(prefixedPath.length)
            : object.Key;

        if (!path) {
          continue;
        }

        results.push({
          path,
          etag: object.ETag ?? "",
          modified: object.LastModified ?? new Date(),
        });
      }

      token = response.NextContinuationToken;
    } while (token);

    return results;
  }

  async delete(path: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(path),
      }),
    );
  }
}
