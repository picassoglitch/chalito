import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GoogleAuth } from "google-auth-library";

/**
 * Server-side wrapping of BYO brain keys (only when the person opts in to cloud turns). The key
 * is wrapped by Cloud KMS with AAD bound to `brainkey:<owner>:<provider>`, so a wrapped copy
 * can't be moved to another account or provider. Plaintext exists only in memory for a call.
 */
export interface KeyWrapper {
  wrap(plaintext: string, aad: string): Promise<string>;
  unwrap(wrapped: string, aad: string): Promise<string>;
}

export const brainKeyAad = (owner: string, provider: string) => `brainkey:${owner}:${provider}`;

/** Cloud KMS symmetric encrypt/decrypt over REST (ADC on Cloud Run). */
export class CloudKmsWrapper implements KeyWrapper {
  readonly #auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloudkms"] });
  constructor(
    /** projects/…/locations/…/keyRings/…/cryptoKeys/… */
    private readonly keyName: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async #post(op: "encrypt" | "decrypt", body: Record<string, string>) {
    const token = await this.#auth.getAccessToken();
    const res = await this.fetcher(`https://cloudkms.googleapis.com/v1/${this.keyName}:${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`kms ${op} failed: ${res.status}`);
    return (await res.json()) as Record<string, string>;
  }
  async wrap(plaintext: string, aad: string) {
    const r = await this.#post("encrypt", {
      plaintext: Buffer.from(plaintext).toString("base64"),
      additionalAuthenticatedData: Buffer.from(aad).toString("base64"),
    });
    return r.ciphertext!;
  }
  async unwrap(wrapped: string, aad: string) {
    const r = await this.#post("decrypt", {
      ciphertext: wrapped,
      additionalAuthenticatedData: Buffer.from(aad).toString("base64"),
    });
    return Buffer.from(r.plaintext!, "base64").toString("utf8");
  }
}

/** AES-256-GCM with a local key: tests and local dev only (a stand-in for KMS, no cloud). */
export class LocalKeyWrapper implements KeyWrapper {
  constructor(private readonly key: Buffer = randomBytes(32)) {}
  async wrap(plaintext: string, aad: string) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }
  async unwrap(wrapped: string, aad: string) {
    const b = Buffer.from(wrapped, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  }
}
