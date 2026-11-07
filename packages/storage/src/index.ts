import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

export interface StoragePutResult {
  key: string;
  size: number;
}

export interface Storage {
  /** Store a payload and return its key + byte size. */
  put(key: string, body: Buffer, contentType: string): Promise<StoragePutResult>;
  getBuffer(key: string): Promise<Buffer>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  /** A URL the browser can fetch directly, when the driver supports it (S3). */
  presignedGetUrl?(key: string, expiresSec?: number): Promise<string>;
}

// ───────────────────── Local filesystem driver ─────────────────────

class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  private path(key: string) {
    // prevent path traversal; keys are tenant/run scoped
    const safe = key.replace(/\.\./g, '').replace(/^\/+/, '');
    return join(resolve(this.root), safe);
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<StoragePutResult> {
    const p = this.path(key);
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    return { key, size: body.byteLength };
  }

  async getBuffer(key: string): Promise<Buffer> {
    return fs.readFile(this.path(key));
  }

  async getStream(key: string): Promise<Readable> {
    return createReadStream(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.path(key), { force: true });
  }
}

// ───────────────────── S3 / MinIO driver (lazy) ─────────────────────

class S3Storage implements Storage {
  private clientPromise: Promise<any> | null = null;
  constructor(
    private readonly cfg: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKey: string;
      secretKey: string;
      forcePathStyle: boolean;
    },
  ) {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) =>
        new S3Client({
          endpoint: this.cfg.endpoint,
          region: this.cfg.region,
          forcePathStyle: this.cfg.forcePathStyle,
          credentials: { accessKeyId: this.cfg.accessKey, secretAccessKey: this.cfg.secretKey },
        }),
      );
    }
    return this.clientPromise;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoragePutResult> {
    const c = await this.client();
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await c.send(
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return { key, size: body.byteLength };
  }

  async getBuffer(key: string): Promise<Buffer> {
    const stream = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  async getStream(key: string): Promise<Readable> {
    const c = await this.client();
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const res = await c.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return res.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    const c = await this.client();
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await c.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }

  async presignedGetUrl(key: string, expiresSec = 300): Promise<string> {
    const c = await this.client();
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return getSignedUrl(c, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), {
      expiresIn: expiresSec,
    });
  }
}

// ───────────────────── Factory ─────────────────────

let _storage: Storage | undefined;

export function getStorage(): Storage {
  if (_storage) return _storage;
  const driver = process.env.STORAGE_DRIVER ?? 'local';
  if (driver === 's3') {
    _storage = new S3Storage({
      endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      region: process.env.S3_REGION ?? 'eu-central-1',
      bucket: process.env.S3_BUCKET ?? 'cronapp-responses',
      accessKey: process.env.S3_ACCESS_KEY ?? '',
      secretKey: process.env.S3_SECRET_KEY ?? '',
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
    });
  } else {
    _storage = new LocalStorage(process.env.STORAGE_LOCAL_PATH ?? './storage');
  }
  return _storage;
}

export const INLINE_MAX_BYTES = parseInt(process.env.STORAGE_INLINE_MAX_BYTES ?? '8192', 10);

/** Object-storage key convention for a run's response payload. */
export function responseKey(tenantId: string, runId: string): string {
  return `tenants/${tenantId}/runs/${runId}.payload`;
}
