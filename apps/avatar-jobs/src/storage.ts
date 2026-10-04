import type { Storage } from "@google-cloud/storage";

/** The avatar bucket, as the job sees it. */
export interface BlobStore {
  read(path: string): Promise<{ bytes: Buffer; contentType: string | null } | null>;
  write(path: string, bytes: Buffer, contentType: string): Promise<void>;
}

/** Uploads land at uploads/<owner>/<assetId>/original; outputs go to avatars/<owner>/<assetId>/. */
const OWNER = /^[A-Za-z0-9_-]{1,128}$/;
const ASSET = /^[A-Za-z0-9_-]{8,64}$/;
export const UPLOAD = /^uploads\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{8,64})\/original$/;

export const uploadPath = (owner: string, assetId: string) => {
  if (!OWNER.test(owner) || !ASSET.test(assetId)) throw new Error("bad owner or asset id");
  return `uploads/${owner}/${assetId}/original`;
};
export const outputPrefix = (owner: string, assetId: string) => {
  if (!OWNER.test(owner) || !ASSET.test(assetId)) throw new Error("bad owner or asset id");
  return `avatars/${owner}/${assetId}/`;
};

/** GCS. Objects are private; the web reads them through short-lived signed URLs from the api. */
export class GcsBlobStore implements BlobStore {
  constructor(
    private readonly storage: Storage,
    private readonly bucket: string,
  ) {}

  async read(path: string) {
    const file = this.storage.bucket(this.bucket).file(path);
    try {
      const [[bytes], [meta]] = await Promise.all([file.download(), file.getMetadata()]);
      return { bytes, contentType: meta.contentType ?? null };
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async write(path: string, bytes: Buffer, contentType: string) {
    await this.storage
      .bucket(this.bucket)
      .file(path)
      .save(bytes, {
        contentType,
        resumable: false,
        metadata: { cacheControl: "private, max-age=31536000, immutable" },
      });
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string | null }>();
  async read(path: string) {
    return this.objects.get(path) ?? null;
  }
  async write(path: string, bytes: Buffer, contentType: string) {
    this.objects.set(path, { bytes, contentType });
  }
}
