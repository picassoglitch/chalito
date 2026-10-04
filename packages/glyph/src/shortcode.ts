import { crockford32, randomBytes } from "@chalito/crypto";

/** 8 Crockford base32 characters (40 bits) as "XXXX-XXXX". */
export const generateShortCode = async (): Promise<string> => {
  const c = crockford32(await randomBytes(5)).slice(0, 8);
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};

/** Normalises user input: upper-case, Crockford aliases (O→0, I/L→1), dash re-inserted. */
export const normalizeShortCode = (input: string): string | null => {
  const raw = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
};

/** SHA-256 hex; only hashes are stored server-side. */
export const hashShortCode = async (code: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};
