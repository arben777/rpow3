// Image storage abstraction for billboard slot images.
//
// Two backends:
//   - "memory": in-process Map. Default for dev/test/CI. Served via the
//     server's own /billboard/image/:slot/v:version endpoint.
//   - "s3": S3-compatible (Backblaze B2 or any other S3 service).
//     Same passthrough URL — the server fetches from B2 and pipes to the
//     client — unless STORAGE_PUBLIC_URL_BASE is set, in which case the
//     image_url returned to the front-end is "<base>/<key>" so traffic
//     bypasses the server entirely.
//
// The S3 client is loaded lazily via dynamic import so the dependency
// is only required when the s3 backend is actually selected (keeps the
// dev/test path zero-deps).

export interface StoredImage {
  bytes: Buffer;
  contentType: string;
}

export interface ImageStore {
  /** Upload bytes and return the canonical object key. */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredImage | null>;
  /** Best-effort delete. Always resolves; failures are logged upstream. */
  del(key: string): Promise<void>;
  /** Public URL for a key, or null when there's no public route. */
  publicUrl(key: string): string | null;
}

class MemoryStore implements ImageStore {
  private map = new Map<string, StoredImage>();
  async put(key: string, bytes: Buffer, contentType: string) {
    this.map.set(key, { bytes, contentType });
  }
  async get(key: string) { return this.map.get(key) ?? null; }
  async del(key: string) { this.map.delete(key); }
  publicUrl(_key: string) { return null; }
}

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrlBase?: string;
}

class S3Store implements ImageStore {
  // We hold the lazily-loaded S3 client behind a one-shot promise so the
  // first call constructs it and subsequent calls reuse it without races.
  private clientPromise: Promise<unknown> | null = null;

  constructor(private cfg: S3Config) {}

  private async client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { S3Client } = await import('@aws-sdk/client-s3');
        return new S3Client({
          endpoint: this.cfg.endpoint,
          region: this.cfg.region,
          credentials: {
            accessKeyId: this.cfg.accessKeyId,
            secretAccessKey: this.cfg.secretAccessKey,
          },
          forcePathStyle: true, // B2 + most S3 clones prefer path style
        });
      })();
    }
    return this.clientPromise;
  }

  async put(key: string, bytes: Buffer, contentType: string) {
    const {PutObjectCommand } = await import('@aws-sdk/client-s3');
    const c = await this.client();
    await c.send(new PutObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  }

  async get(key: string): Promise<StoredImage | null> {
    const {GetObjectCommand } = await import('@aws-sdk/client-s3');
    const c = await this.client();
    try {
      const r = await c.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      const stream = r.Body as { transformToByteArray(): Promise<Uint8Array> };
      const bytes = Buffer.from(await stream.transformToByteArray());
      return { bytes, contentType: r.ContentType ?? 'application/octet-stream' };
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async del(key: string) {
    try {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const c = await this.client();
      await c.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    } catch {
      // Best-effort. If a stale image lingers, the slot row still has the
      // canonical pointer; we don't want a delete failure to block ABANDON.
    }
  }

  publicUrl(key: string) {
    if (this.cfg.publicUrlBase) return `${this.cfg.publicUrlBase.replace(/\/+$/, '')}/${key}`;
    return null;
  }
}

export interface CreateImageStoreOptions {
  backend: 'memory' | 's3';
  s3?: S3Config;
}

export function createImageStore(o: CreateImageStoreOptions): ImageStore {
  if (o.backend === 's3') {
    if (!o.s3) throw new Error('imageStore: s3 backend selected but s3 config missing');
    return new S3Store(o.s3);
  }
  return new MemoryStore();
}

/** Build the canonical object key for a slot image. */
export function objectKeyFor(slotId: number, version: number, ext: 'png' | 'jpg' | 'webp'): string {
  return `slots/${slotId}/v${version}.${ext}`;
}

/** Map a content-type to the correct file extension. Throws on unknown. */
export function extForContentType(ct: string): 'png' | 'jpg' | 'webp' {
  switch (ct) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    default: throw new Error(`unsupported image content type: ${ct}`);
  }
}
