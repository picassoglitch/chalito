import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SigningKeyPair } from "@chalito/crypto";
import { AgentLink, EpochMs, LinkId } from "@chalito/protocol";
import { signLocal, verifyLocal } from "../local-sig.js";

/**
 * This device's links and their counters (ADR 0022 §3). The links are the permission, so they
 * live on the device, never in the cloud: `~/.chalito/links.json` (0600), signed with the agent's
 * own key (`chalito.links-file.v1`). A file that doesn't verify (edited by hand or by a session)
 * loads as **no links**, so tampering can only remove permissions, never add one.
 */
export const LinkState = z.object({
  v: z.literal(1),
  links: z.array(AgentLink).max(200),
  /** Revoked ids (kept so a replayed relay or a stale mirror can't bring one back). */
  revoked: z.array(z.object({ id: LinkId, at: EpochMs, by: z.string().max(64) })).max(2000),
  /** Tokens spent per link on the current UTC day ("YYYY-MM-DD"). */
  usage: z.record(LinkId, z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tokens: z.number().int().min(0) })),
  /** Delivery times per link in the last hour (the rate limit). */
  deliveries: z.record(LinkId, z.array(EpochMs).max(1000)),
});
export type LinkState = z.infer<typeof LinkState>;

export const EMPTY_LINK_STATE: LinkState = { v: 1, links: [], revoked: [], usage: {}, deliveries: {} };

export interface LinkStorage {
  /** `tampered` when a file existed but didn't verify (it then loads as empty). */
  load(): { state: LinkState; tampered: boolean };
  save(state: LinkState): void;
}

export class MemoryLinkStorage implements LinkStorage {
  state: LinkState = structuredClone(EMPTY_LINK_STATE);
  load() {
    return { state: structuredClone(this.state), tampered: false };
  }
  save(state: LinkState) {
    this.state = structuredClone(state);
  }
}

export class FileLinkStorage implements LinkStorage {
  readonly #file: string;
  constructor(
    dir: string,
    private readonly keys: SigningKeyPair,
  ) {
    this.#file = join(dir, "links.json");
  }

  load(): { state: LinkState; tampered: boolean } {
    if (!existsSync(this.#file)) return { state: structuredClone(EMPTY_LINK_STATE), tampered: false };
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8")) as { body?: unknown; sig?: unknown };
      const parsed = LinkState.safeParse(raw.body);
      if (parsed.success && verifyLocal("chalito.links-file.v1", raw.body, raw.sig, this.keys.publicKey))
        return { state: parsed.data, tampered: false };
    } catch {
      // fall through: unreadable is treated like tampered
    }
    return { state: structuredClone(EMPTY_LINK_STATE), tampered: true };
  }

  save(state: LinkState): void {
    const body = LinkState.parse(state);
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ body, sig: signLocal("chalito.links-file.v1", body, this.keys) }), {
      mode: 0o600,
    });
    renameSync(tmp, this.#file);
  }
}
