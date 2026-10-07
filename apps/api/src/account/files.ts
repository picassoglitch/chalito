import type { Storage } from "@google-cloud/storage";
import { deleteAllVersions } from "../lib/gcs-versions.js";

/** Where an owner's files live: the export, avatar uploads and cards, records. */
export interface AccountFiles {
  putExport(owner: string, id: string, bytes: Buffer): Promise<string>;
  getExport(path: string): Promise<Buffer | null>;
  /** Deletes every object under the owner's prefixes, noncurrent versions included; returns how many generations. */
  deleteOwner(owner: string): Promise<number>;
}

const OWNER = /^[A-Za-z0-9_-]{1,128}$/;
const check = (owner: string) => {
  if (!OWNER.test(owner)) throw new Error("bad owner id");
  return owner;
};

/**
 * GCS: exports in `exportBucket` under exports/<owner>/; owner prefixes deleted across the
 * configured buckets (avatars/<owner>/ and uploads/<owner>/ in the avatar bucket, the records
 * bucket's <owner>/). Prefixes always end with "/", so one owner's prefix never matches another's.
 */
export class GcsAccountFiles implements AccountFiles {
  constructor(
    private readonly storage: Storage,
    private readonly o: { exportBucket: string; prefixes: { bucket: string; prefix: (owner: string) => string }[] },
  ) {}

  async putExport(owner: string, id: string, bytes: Buffer) {
    const path = `exports/${check(owner)}/${id}.json`;
    await this.storage
      .bucket(this.o.exportBucket)
      .file(path)
      .save(bytes, {
        contentType: "application/json",
        resumable: false,
        metadata: { cacheControl: "private, no-store" },
      });
    return path;
  }

  async getExport(path: string) {
    try {
      const [b] = await this.storage.bucket(this.o.exportBucket).file(path).download();
      return b;
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async deleteOwner(owner: string) {
    let n = 0;
    const all = [...this.o.prefixes, { bucket: this.o.exportBucket, prefix: (x: string) => `exports/${x}/` }];
    for (const { bucket, prefix } of all) {
      const p = prefix(check(owner));
      if (!p.endsWith(`${owner}/`)) throw new Error(`unsafe prefix ${p}`);
      // Every version too: erasure leaves nothing in the buckets' 30-day noncurrent-version window.
      n += await deleteAllVersions(this.storage.bucket(bucket), p);
    }
    return n;
  }
}

export class MemoryAccountFiles implements AccountFiles {
  readonly objects = new Map<string, Buffer>();
  async putExport(owner: string, id: string, bytes: Buffer) {
    const path = `exports/${check(owner)}/${id}.json`;
    this.objects.set(path, bytes);
    return path;
  }
  async getExport(path: string) {
    return this.objects.get(path) ?? null;
  }
  async deleteOwner(owner: string) {
    let n = 0;
    for (const k of [...this.objects.keys()])
      if (k.split("/")[1] === check(owner)) {
        this.objects.delete(k);
        n++;
      }
    return n;
  }
}
