import type { AdapterKind } from "@chalito/protocol";
import type { SessionAdapter, SessionHandle, SessionStartOptions } from "./core.js";

/** "IA de Chalyb" (ADR 0030): a per-session credential for our ai-gateway, never a provider key. */
export interface ManagedCredential {
  id: string;
  /** Opaque, revocable, bound to this session: goes only into the CLI's environment or authenticate. */
  token: string;
  /** The gateway's root URL (no /v1): each adapter adds what its CLI expects. */
  baseUrl: string;
  model: string;
}

export type ManagedBlock = "out_of_energy" | "daily_cap";

/** The gateway is https; plain http only on this machine (a local stack). */
export const GATEWAY_URL = /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$))/;

/** The api's /v1/coding/credentials, as the agent's device. */
export interface ManagedSource {
  issue(sid: string): Promise<ManagedCredential>;
  status(id: string): Promise<{ state: "active" | "revoked" | "expired"; blockedReason: ManagedBlock | null }>;
  end(id: string): Promise<void>;
}

const TURN_OVER = new Set(["idle", "completed", "failed", "interrupted"]);

/** Each session on a fresh credential: issued before the CLI starts, checked after every turn (out of tokens or
 *  over the cap → a `blocked` event), revoked when the session ends. */
export class ManagedSessionAdapter implements SessionAdapter {
  readonly localMcp?: boolean;
  constructor(
    readonly kind: AdapterKind,
    private readonly d: {
      source: ManagedSource;
      /** The agent's own adapter for this credential (its env and overrides point at the gateway). */
      make: (c: ManagedCredential) => SessionAdapter;
      localMcp?: boolean;
      log?: (msg: string, meta: Record<string, unknown>) => void;
    },
  ) {
    if (d.localMcp) this.localMcp = true;
  }

  async start(opts: SessionStartOptions): Promise<SessionHandle> {
    let cred: ManagedCredential;
    try {
      cred = await this.d.source.issue(opts.sid);
    } catch (err) {
      // Out of tokens or over the cap already: the owner sees the same chip as mid-session.
      const b = (err as { blocked?: ManagedBlock | null } | null)?.blocked;
      if (b) opts.onEvent({ type: "blocked", reason: b });
      throw err;
    }
    let blocked: ManagedBlock | null = null;
    const check = async () => {
      try {
        const s = await this.d.source.status(cred.id);
        // Reported once per block; a later turn that passes clears it.
        if (s.blockedReason && s.blockedReason !== blocked) opts.onEvent({ type: "blocked", reason: s.blockedReason });
        blocked = s.blockedReason;
        // Expired, idle or revoked: end this process; the next prompt resumes the session on a new credential.
        if (s.state !== "active") handle?.close();
      } catch (err) {
        this.d.log?.("managed.status_failed", {
          credential: cred.id,
          error: err instanceof Error ? err.name : "error",
        });
      }
    };
    let handle: SessionHandle | undefined;
    try {
      handle = await this.d.make(cred).start({
        ...opts,
        onEvent: (e) => {
          opts.onEvent(e);
          if (e.type === "state" && TURN_OVER.has(e.state)) void check();
        },
      });
    } catch (err) {
      await this.d.source.end(cred.id).catch(() => undefined); // the CLI never started: best effort
      throw err;
    }
    // Revoked however the session ends; a failed revoke is logged (the credential still expires).
    const end = () =>
      void this.d.source.end(cred.id).catch((err: unknown) =>
        this.d.log?.("managed.end_failed", {
          credential: cred.id,
          error: err instanceof Error ? err.message : "error",
        }),
      );
    handle.done.then(end, end);
    return handle;
  }
}
