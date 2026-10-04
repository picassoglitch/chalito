import { ready } from "./sodium.js";

/** Unpadded base64url, matching `b64url` in @chalito/protocol. */
export const toB64url = async (bytes: Uint8Array): Promise<string> => {
  const s = await ready();
  return s.to_base64(bytes, s.base64_variants.URLSAFE_NO_PADDING);
};

export const fromB64url = async (text: string): Promise<Uint8Array> => {
  const s = await ready();
  return s.from_base64(text, s.base64_variants.URLSAFE_NO_PADDING);
};

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
