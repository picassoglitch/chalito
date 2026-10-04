import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";

/**
 * Release downloads come from the PRIVATE `releases` bucket in Chalyb's project (ADR 0014):
 * the api hands out V4 signed URLs that live a few minutes. Signing uses the dedicated
 * `chalito-release-signer` service account through IAM Credentials `signBlob` (no key file
 * anywhere); that account can only read the releases bucket.
 *
 * V4 signing, per https://cloud.google.com/storage/docs/access-control/signing-urls-manually:
 *   canonical request → SHA-256 → "GOOG4-RSA-SHA256\n<datetime>\n<scope>\n<hash>" → RSA-SHA256
 *   by the service account → hex signature as X-Goog-Signature.
 */

const HOST = "storage.googleapis.com";

/** RFC 3986 percent-encoding (encodeURIComponent leaves !'()* alone). */
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (object: string) => object.split("/").map(enc).join("/");

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

export interface SignBlob {
  /** Returns the RSA-SHA256 signature of `data` by `email` (raw bytes). */
  (email: string, data: Uint8Array): Promise<Uint8Array>;
}

export const v4SignedUrl = async (o: {
  bucket: string;
  object: string;
  signerEmail: string;
  now: Date;
  expiresSec: number;
  signBlob: SignBlob;
}): Promise<string> => {
  if (o.expiresSec < 1 || o.expiresSec > 604_800) throw new Error("expiresSec out of range");
  const datetime = stamp(o.now);
  const scope = `${datetime.slice(0, 8)}/auto/storage/goog4_request`;
  const path = `/${enc(o.bucket)}/${encPath(o.object)}`;
  const query = [
    ["X-Goog-Algorithm", "GOOG4-RSA-SHA256"],
    ["X-Goog-Credential", `${o.signerEmail}/${scope}`],
    ["X-Goog-Date", datetime],
    ["X-Goog-Expires", String(o.expiresSec)],
    ["X-Goog-SignedHeaders", "host"],
  ]
    .map(([k, v]) => `${enc(k!)}=${enc(v!)}`)
    .sort()
    .join("&");
  const canonical = ["GET", path, query, `host:${HOST}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["GOOG4-RSA-SHA256", datetime, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const sig = await o.signBlob(o.signerEmail, new TextEncoder().encode(toSign));
  return `https://${HOST}${path}?${query}&X-Goog-Signature=${Buffer.from(sig).toString("hex")}`;
};

export interface ReleaseStore {
  /** The channel's latest.json (parsed JSON), or null when there is none. */
  manifest(channel: string): Promise<unknown>;
  /** A short-lived signed download URL for an object in the releases bucket. */
  signedUrl(object: string, expiresSec: number): Promise<string>;
}

/**
 * The real store: everything goes through URLs signed as the release signer (IAM Credentials
 * signBlob with the runtime's ADC), so the api's own account needs only Token Creator on the
 * signer and no role on the bucket.
 */
export class GcsReleaseStore implements ReleaseStore {
  readonly #auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

  constructor(
    private readonly bucket: string,
    private readonly signerEmail: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read through a signed URL too: the api itself holds no role on the bucket. */
  async manifest(channel: string): Promise<unknown> {
    const res = await fetch(await this.signedUrl(`${channel}/latest.json`, 60));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`releases manifest: HTTP ${res.status}`);
    return res.json();
  }

  signedUrl(object: string, expiresSec: number): Promise<string> {
    return v4SignedUrl({
      bucket: this.bucket,
      object,
      signerEmail: this.signerEmail,
      now: new Date(this.now()),
      expiresSec,
      signBlob: async (email, data) => {
        const client = await this.#auth.getClient();
        const res = await client.request<{ signedBlob: string }>({
          url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${enc(email)}:signBlob`,
          method: "POST",
          data: { payload: Buffer.from(data).toString("base64") },
        });
        return new Uint8Array(Buffer.from(res.data.signedBlob, "base64"));
      },
    });
  }
}
