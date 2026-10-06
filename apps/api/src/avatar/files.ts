import type { Storage } from "@google-cloud/storage";

/** uploads/<owner>/<assetId>/original (apps/avatar-jobs src/storage.ts, the Workflow's filter). */
export const uploadObject = (owner: string, assetId: string) => `uploads/${owner}/${assetId}/original`;
/** avatars/<owner>/<assetId>/<file>: what the job writes. */
export const cardObject = (owner: string, assetId: string, file: string) => `avatars/${owner}/${assetId}/${file}`;

export interface SignedUpload {
  url: string;
  method: "PUT";
  /** Headers the upload must carry exactly (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: number;
}

/** The avatar bucket as the api uses it. Objects stay private; the browser gets short-lived URLs. */
export interface AvatarFiles {
  /** A V4 signed PUT for one object: this content type only, at most `maxBytes`. */
  signedUpload(object: string, contentType: string, maxBytes: number, expiresSec: number): Promise<SignedUpload>;
  signedRead(object: string, expiresSec: number): Promise<string>;
  /** The object's size and content type, or null when there is none. */
  stat(object: string): Promise<{ size: number; contentType: string | null } | null>;
  /** Deletes the object and every older version of it (the bucket is versioned). */
  deleteAll(object: string): Promise<void>;
}

export class GcsAvatarFiles implements AvatarFiles {
  constructor(
    private readonly storage: Storage,
    private readonly bucket: string,
    private readonly now: () => number = Date.now,
  ) {}

  async signedUpload(object: string, contentType: string, maxBytes: number, expiresSec: number) {
    const expiresAt = this.now() + expiresSec * 1000;
    const headers = { "content-type": contentType, "x-goog-content-length-range": `0,${maxBytes}` };
    // Signed as the api's own service account (IAM signBlob, no key file): it needs Token Creator on itself.
    const [url] = await this.storage
      .bucket(this.bucket)
      .file(object)
      .getSignedUrl({
        version: "v4",
        action: "write",
        expires: expiresAt,
        contentType,
        extensionHeaders: { "x-goog-content-length-range": headers["x-goog-content-length-range"] },
      });
    return { url, method: "PUT" as const, headers, expiresAt };
  }

  async signedRead(object: string, expiresSec: number) {
    const [url] = await this.storage
      .bucket(this.bucket)
      .file(object)
      .getSignedUrl({ version: "v4", action: "read", expires: this.now() + expiresSec * 1000 });
    return url;
  }

  async stat(object: string) {
    try {
      const [meta] = await this.storage.bucket(this.bucket).file(object).getMetadata();
      return { size: Number(meta.size ?? 0), contentType: meta.contentType ?? null };
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async deleteAll(object: string) {
    const [files] = await this.storage.bucket(this.bucket).getFiles({ prefix: object, versions: true });
    for (const f of files.filter((f) => f.name === object)) await f.delete({ ignoreNotFound: true });
  }
}
