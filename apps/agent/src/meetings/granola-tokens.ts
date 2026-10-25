import type { SecretStore } from "../secrets.js";

/** One keychain entry for the whole OAuth state (Alux kept it in a 0600 JSON file; Chalito keeps no secrets on disk). */
export const GRANOLA_SECRET = "granola-oauth";

/** What the MCP SDK's OAuth provider persists: dynamic client, tokens, PKCE verifier, discovery. */
export interface GranolaAuthState {
  client?: unknown;
  tokens?: unknown;
  verifier?: string;
  state?: string;
  discovery?: unknown;
}

/** The keychain entry is there but unreadable: the person must reconnect, which is not the same as never connected. */
export class GranolaTokensCorruptError extends Error {
  override name = "GranolaTokensCorruptError";
}

export class GranolaTokenStore {
  constructor(private readonly secrets: SecretStore) {}

  async read(): Promise<GranolaAuthState> {
    const raw = await this.secrets.get(GRANOLA_SECRET);
    if (!raw) return {};
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      throw new GranolaTokensCorruptError("Granola sign-in data in the keychain is unreadable");
    }
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new GranolaTokensCorruptError("Granola sign-in data in the keychain has the wrong shape");
    return v as GranolaAuthState;
  }

  /** Merges `patch`; an `undefined` field is removed (sign-out of one part). */
  async save(patch: Partial<GranolaAuthState>): Promise<void> {
    // A reconnect writing fresh state replaces an unreadable entry instead of being blocked by it.
    const current = await this.read().catch((err: unknown) => {
      if (err instanceof GranolaTokensCorruptError) return {};
      throw err;
    });
    const next: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    await this.secrets.set(GRANOLA_SECRET, JSON.stringify(next));
  }

  async connected(): Promise<boolean> {
    return (await this.read()).tokens !== undefined;
  }

  async clear(): Promise<void> {
    await this.secrets.delete(GRANOLA_SECRET);
  }
}
