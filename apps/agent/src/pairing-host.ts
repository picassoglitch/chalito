import { z } from "zod";
import { IpcError, ipcPath, startIpcServer, type IpcHandlers } from "./ipc-server.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { AGENT_VERSION } from "./ipc-handlers.js";
import { isPaired, readConfig } from "./config.js";
import { signEnvelope } from "@chalito/crypto";
import { loadOrCreateIdentity } from "./identity.js";
import { runPair, type PairDeps, type PairResult, type PairingCodeShown } from "./pair.js";
import { loopbackOrigins, startPairingLoopback } from "./pairing-loopback.js";

/**
 * Pairing from the desktop panel (ADR 0028 §3), with no terminal. Before this computer is paired
 * the desktop app starts `chalito run` anyway; with no owner on record and the panel's IPC secret
 * on stdin, the agent serves only this: the ceremony of `chalito pair` (pair.ts, unchanged in
 * what it checks), driven by `startPairing`, `pendingPairing` and `confirmPairing`. The process
 * exits once paired, and the supervisor starts the real daemon.
 *
 * The local reverse check stays local: the trusted list is written only after the person clicks
 * "Sí, fui yo" in the panel (confirmPairing match: true), and replacing an account still needs the
 * typed phrase. OS authentication runs first, as in the CLI (the system prompt on macOS and Linux).
 *
 * While a code waits, the loopback endpoint (pairing-loopback.ts) lets the approval page in this
 * computer's browser prove it is here (one tap, ADR 0028 §4); anything else types the code.
 */

export type PairingPhase =
  | "starting"
  | "waiting"
  | "claimed"
  | "replace"
  | "paired"
  | "expired"
  | "declined"
  | "cancelled"
  | "rejected"
  | "failed";

/** What `pendingPairing` returns (apps/desktop/src/lib/ipc.ts `PendingPairing`). */
export interface PairingView {
  pairingId: string;
  state: PairingPhase;
  /** This computer, as the approval screen will show it. Null until the api answered. */
  computer: Omit<PairingCodeShown, "codeId"> | null;
  /** The approving device, for the reverse check ("¿Lo aprobaste tú?"). */
  claimer: { fingerprint: string; passkeyId: string | null } | null;
  /** In `replace`: the phrase to type before this computer changes account. */
  replacePhrase: string | null;
  /** In `failed`: a short code for the panel (never a stack or a path). */
  error: string | null;
}

const Start = z.object({ kind: z.enum(["desktop", "laptop"]).optional() }).optional();
const Confirm = z.object({
  pairingId: z.string().max(128),
  match: z.boolean(),
  typed: z.string().max(64).optional(),
});

const parse = <T>(schema: z.ZodType<T>, params: unknown): T => {
  const r = schema.safeParse(params);
  if (!r.success) throw new IpcError("bad_params");
  return r.data;
};

type Answer = { match: boolean; typed?: string };

/** One pairing at a time, its answers coming from the panel instead of a terminal. */
export class PanelPairing {
  #view: PairingView | null = null;
  #abort: AbortController | null = null;
  #answer: ((a: Answer) => void) | null = null;
  #seq = 0;
  #codeId: string | null = null;
  readonly done: Promise<PairResult & { ok: true }>;
  #resolveDone!: (r: PairResult & { ok: true }) => void;

  constructor(
    private readonly deps: Omit<
      PairDeps,
      "confirm" | "confirmTyped" | "out" | "onCode" | "onClaimed" | "signal" | "kind"
    >,
  ) {
    this.done = new Promise((r) => (this.#resolveDone = r));
  }

  view(): PairingView | null {
    return this.#view ? { ...this.#view } : null;
  }

  /** Starts a pairing, or returns the one already in progress. */
  start(kind: "desktop" | "laptop" = "desktop"): PairingView {
    const live = this.#view && ["starting", "waiting", "claimed", "replace"].includes(this.#view.state);
    if (live) return this.view()!;
    const pairingId = `pair_${++this.#seq}_${Date.now().toString(36)}`;
    const abort = new AbortController();
    this.#abort = abort;
    this.#view = { pairingId, state: "starting", computer: null, claimer: null, replacePhrase: null, error: null };
    const set = (patch: Partial<PairingView>) => {
      if (this.#view?.pairingId === pairingId) this.#view = { ...this.#view, ...patch };
    };
    const ask = (patch: Partial<PairingView>) =>
      new Promise<Answer>((resolve) => {
        set(patch);
        this.#answer = resolve;
      });
    void runPair({
      ...this.deps,
      kind,
      signal: abort.signal,
      out: () => undefined,
      onCode: ({ codeId, ...computer }) => {
        if (this.#view?.pairingId === pairingId) this.#codeId = codeId;
        set({ state: "waiting", computer });
      },
      onClaimed: (claimer) => set({ claimer }),
      confirm: async () => (await ask({ state: "claimed" })).match,
      confirmTyped: async (_q, phrase) => {
        const a = await ask({ state: "replace", replacePhrase: phrase });
        return a.match && a.typed?.trim() === phrase;
      },
    }).then(
      (r) => {
        this.#answer = null;
        this.#codeId = null;
        if (r.ok) {
          set({ state: "paired", replacePhrase: null });
          this.#resolveDone(r);
          return;
        }
        const state: PairingPhase =
          r.reason === "expired" || r.reason === "declined" || r.reason === "cancelled"
            ? r.reason
            : r.reason === "os_auth_failed"
              ? "failed"
              : "rejected";
        set({ state, replacePhrase: null, error: r.reason === "os_auth_failed" ? r.reason : null });
      },
      (err: unknown) => {
        this.#answer = null;
        this.#codeId = null;
        const code = err instanceof Error && /^[a-z_]{2,40}$/.test(err.message) ? err.message : "pairing_failed";
        set({ state: "failed", error: code });
      },
    );
    return this.view()!;
  }

  /**
   * The loopback proof (ADR 0028 §4): only for the code this computer is waiting on, signed with
   * the key it published at /codes. Null otherwise (nothing waiting, another code, already claimed).
   */
  async proveLoopback(codeId: string, nonce: string, origin: string, now = Date.now()): Promise<unknown | null> {
    if (this.#view?.state !== "waiting" || !this.#codeId || codeId !== this.#codeId) return null;
    const id = await loadOrCreateIdentity(this.deps.secrets);
    return signEnvelope(
      "chalito.pairing-loopback.v1",
      { v: 1, codeId, nonce, origin, issuedAt: now },
      id.deviceId,
      id.sign.secretKey,
    );
  }

  /**
   * The panel's answer. While waiting, "no" cancels the code; at the reverse check it is the
   * local y/N; in `replace` it carries the typed phrase.
   */
  confirm(pairingId: string, match: boolean, typed?: string): PairingView {
    const v = this.#view;
    if (!v || v.pairingId !== pairingId) throw new IpcError("no_pending_pairing");
    if ((v.state === "waiting" || v.state === "starting") && !match) {
      this.#abort?.abort();
      return this.view()!;
    }
    if ((v.state !== "claimed" && v.state !== "replace") || !this.#answer) throw new IpcError("no_pending_pairing");
    const answer = this.#answer;
    this.#answer = null;
    answer({ match, ...(typed !== undefined ? { typed } : {}) });
    return this.view()!;
  }
}

/** The IPC calls the panel uses before this computer is paired. */
export const pairingHandlers = (p: PanelPairing): IpcHandlers => ({
  ping: async () => ({ version: AGENT_VERSION, paired: false }),
  startPairing: async (params) => p.start(parse(Start, params)?.kind),
  pendingPairing: async () => p.view(),
  confirmPairing: async (params) => {
    const { pairingId, match, typed } = parse(Confirm, params);
    return p.confirm(pairingId, match, typed);
  },
});

/**
 * `chalito run` on a computer that isn't paired yet, started by the desktop app (IPC secret on
 * stdin). Resolves once paired (the caller exits 0, the supervisor then starts the daemon).
 */
export const runPairingHost = async (opts: {
  dir: string;
  secret: string;
  pair: ConstructorParameters<typeof PanelPairing>[0];
  lock?: (dir: string) => () => void;
  platform?: NodeJS.Platform;
  /** How often to notice a pairing done elsewhere (`chalito pair` in a terminal). */
  pollMs?: number;
  loopbackPorts?: readonly number[];
  /** Ends the host early (the desktop app that started it is gone). */
  signal?: AbortSignal;
}): Promise<void> => {
  const release = (opts.lock ?? acquireInstanceLock)(opts.dir);
  // The pairing object exists before the loopback starts; the port only goes into the link.
  let pairing: PanelPairing | null = null;
  const loopback = await startPairingLoopback({
    origins: loopbackOrigins(opts.pair.env ?? process.env),
    prove: (codeId, nonce, origin) => pairing?.proveLoopback(codeId, nonce, origin) ?? Promise.resolve(null),
    ...(opts.loopbackPorts ? { ports: opts.loopbackPorts } : {}),
  }).catch(() => null);
  pairing = new PanelPairing({ ...opts.pair, ...(loopback ? { loopbackPort: loopback.port } : {}) });
  const server = await startIpcServer({
    path: ipcPath(opts.dir, opts.platform),
    secret: opts.secret,
    handlers: pairingHandlers(pairing),
    ...(opts.platform ? { platform: opts.platform } : {}),
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  const pairedElsewhere = new Promise<void>((resolve) => {
    timer = setInterval(() => {
      try {
        if (isPaired(readConfig(opts.dir, opts.pair.env))) resolve();
      } catch {
        /* no config yet */
      }
    }, opts.pollMs ?? 5000);
  });
  try {
    const aborted = new Promise<"aborted">((resolve) => {
      if (opts.signal?.aborted) resolve("aborted");
      opts.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    // Let the panel read the final "paired" state before the socket goes away.
    if ((await Promise.race([pairing.done, pairedElsewhere, aborted])) !== "aborted")
      await new Promise((r) => setTimeout(r, 1500));
  } finally {
    clearInterval(timer);
    await loopback?.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    release();
  }
};
