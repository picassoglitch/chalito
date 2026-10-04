import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Opaque, high-entropy tokens; only their SHA-256 is stored. */
export const newSecret = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))) == code_challenge, in constant time. */
export const pkceS256Ok = (verifier: string, challenge: string): boolean => {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Compare resource URIs ignoring a fragment and one trailing slash (as the MCP SDK does). */
export const sameResource = (a: string, b: string): boolean => {
  const norm = (u: string) => {
    try {
      const x = new URL(u);
      x.hash = "";
      return x.toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  };
  const na = norm(a);
  return na !== null && na === norm(b);
};
