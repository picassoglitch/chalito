import { toB64url } from "./encoding.js";
import { randomBytes } from "./keys.js";

/** 16 random bytes as unpadded base64url (`ReplayNonce` in @chalito/protocol). */
export const randomNonce = async (): Promise<string> => toB64url(await randomBytes(16));

/**
 * Remembers nonces until their message expires. `claim` returns false for a replay.
 * The agent persists its store under ~/.chalito; this in-memory one is for tests and clients.
 */
export interface NonceStore {
  claim(nonce: string, expiresAt: number, now: number): Promise<boolean>;
}

export class MemoryNonceStore implements NonceStore {
  readonly #seen = new Map<string, number>();

  async claim(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    for (const [n, exp] of this.#seen) if (exp <= now) this.#seen.delete(n);
    if (expiresAt <= now) return false;
    if (this.#seen.has(nonce)) return false;
    this.#seen.set(nonce, expiresAt);
    return true;
  }
}
