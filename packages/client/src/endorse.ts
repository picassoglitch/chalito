import {
  CreateEndorseCodeResponse,
  TakeEndorsementResponse,
  type DeviceRegistration,
  type Endorsement,
} from "@chalito/protocol";
import { createBrowserSupabase, memoryStorage, type BrowserSupabase } from "./auth.js";

/**
 * The NEW device's side of the endorsement handoff (/v1/endorse, ADR 0006): a browser or the
 * desktop panel, signed in as the person but not yet a trusted client. It publishes its
 * self-signed registration, shows the code (glyph + short code), waits on
 * `chalito:pairing:<codeId>` with the scoped watch token, then takes the endorsement once.
 * The trusted client's side is in @chalito/client-keys (`resolveForEndorsement`,
 * `approveEndorsement`).
 */

/** How a registration reaches a trusted client and its endorsement comes back. */
export interface EndorsementChannel {
  open(registration: DeviceRegistration): Promise<{
    /** What the new device shows: see `EndorseDisplay` for the api-backed channel. */
    display: unknown;
    endorsement: Promise<Endorsement>;
    cancel(): void;
  }>;
}

export interface EndorseDisplay {
  codeId: string;
  /** Typed on the trusted device when scanning isn't possible. */
  shortCode: string;
  expiresAt: number;
  /** The `endorse_client` glyph this device signed over the code (null if not provided). */
  glyph: unknown;
}

export class EndorsementUnavailableError extends Error {
  override name = "EndorsementUnavailableError";
  constructor() {
    super("endorsement_channel_unavailable");
  }
}

export class EndorseCodeExpiredError extends Error {
  override name = "EndorseCodeExpiredError";
  constructor() {
    super("endorse_code_expired");
  }
}

export class EndorseFailedError extends Error {
  override name = "EndorseFailedError";
  constructor(readonly code: string) {
    super(`endorse_failed: ${code}`);
  }
}

/**
 * The endorsement must vouch for exactly this account and these keys. The api checks it too;
 * the new device checks before posting it anyway.
 */
export const endorsementMatches = (e: Endorsement, reg: DeviceRegistration): boolean =>
  e.body.uid === reg.body.owner &&
  e.body.newDeviceId === reg.body.deviceId &&
  e.body.pubSign === reg.body.pubSign &&
  e.body.pubBox === reg.body.pubBox;

export const unavailableEndorsement: EndorsementChannel = {
  open: () => Promise.reject(new EndorsementUnavailableError()),
};

/** The api calls this side makes, authenticated as the person (`user`). */
export interface PostApi {
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

/** Errors from a PostApi carry the api's error code (client-keys' ApiError does). */
const codeOf = (err: unknown): string | null => {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : null;
};

/** Listens for pointers on the code's topic; calls `onPointer` on each, and once when joined. */
export type EndorseWatch = (codeId: string, watchToken: string, onPointer: () => void) => Promise<() => void>;

/** The topic the api's trigger broadcasts on (the pairing watcher's, ADR 0017 S4). */
export const endorseTopic = (codeId: string) => `chalito:pairing:${codeId}`;

/**
 * Realtime watch with the scoped watch token: its own short-lived client (memory storage, never
 * the person's session), magic-link exchange, setAuth BEFORE joining (realtime-js 2.117).
 */
export const supabaseEndorseWatch =
  (
    url: string,
    publishableKey: string,
    create: (url: string, key: string) => BrowserSupabase = (u, k) => createBrowserSupabase(u, k, memoryStorage()),
  ): EndorseWatch =>
  async (codeId, watchToken, onPointer) => {
    const sb = create(url, publishableKey);
    const { data, error } = await sb.auth.verifyOtp({ token_hash: watchToken, type: "magiclink" });
    const access = data.session?.access_token;
    if (error || !access) throw new EndorseFailedError("watch_failed");
    await sb.realtime.setAuth(access);
    const ch = sb
      .channel(endorseTopic(codeId), { config: { private: true } })
      .on("broadcast", { event: "*" }, () => onPointer())
      .subscribe((status) => {
        // Resync on join: the endorsement may have landed before we listened.
        if (status === "SUBSCRIBED") onPointer();
      });
    return () => {
      void sb.removeChannel(ch).catch(() => undefined);
      void sb.removeAllChannels().catch(() => undefined);
    };
  };

export interface EndorsementChannelOptions {
  api: PostApi;
  watch: EndorseWatch;
  /** Signs the `endorse_client` glyph over the code with this device's key (shown as display.glyph). */
  glyphFor?: (code: { codeId: string; expiresAt: number }) => Promise<unknown>;
  /** Safety net if a pointer is missed (the watch also resyncs on join). */
  pollMs?: number;
  now?: () => number;
  timers?: {
    setTimeout(cb: () => void, ms: number): unknown;
    clearTimeout(h: unknown): void;
    setInterval(cb: () => void, ms: number): unknown;
    clearInterval(h: unknown): void;
  };
}

const realTimers = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
  clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** The api-backed EndorsementChannel. */
export const endorsementChannel = (o: EndorsementChannelOptions): EndorsementChannel => ({
  open: async (registration) => {
    const code = CreateEndorseCodeResponse.parse(await o.api.post("/v1/endorse/codes", { registration }));
    const t = o.timers ?? realTimers;
    const now = o.now ?? Date.now;
    const glyph = o.glyphFor ? await o.glyphFor({ codeId: code.codeId, expiresAt: code.expiresAt }) : null;
    const display: EndorseDisplay = {
      codeId: code.codeId,
      shortCode: code.shortCode,
      expiresAt: code.expiresAt,
      glyph,
    };

    let settled = false;
    let inFlight = false;
    let unwatch: (() => void) | null = null;
    let resolve!: (e: Endorsement) => void;
    let reject!: (err: unknown) => void;
    const endorsement = new Promise<Endorsement>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Callers may not await it until later (e.g. after rendering the display).
    endorsement.catch(() => undefined);

    const stop = () => {
      settled = true;
      t.clearTimeout(expiry);
      t.clearInterval(poll);
      unwatch?.();
      unwatch = null;
    };
    const fail = (err: unknown) => {
      if (settled) return;
      stop();
      reject(err);
    };
    const tryTake = async () => {
      if (settled || inFlight) return;
      inFlight = true;
      try {
        const r = TakeEndorsementResponse.parse(await o.api.post("/v1/endorse/take", { codeId: code.codeId }));
        if (settled) return;
        stop();
        resolve(r.endorsement);
      } catch (err) {
        const c = codeOf(err);
        if (c === "not_endorsed") return; // not yet: keep waiting
        fail(c === "expired" ? new EndorseCodeExpiredError() : new EndorseFailedError(c ?? "failed"));
      } finally {
        inFlight = false;
      }
    };

    const expiry = t.setTimeout(() => fail(new EndorseCodeExpiredError()), Math.max(0, code.expiresAt - now()));
    const poll = t.setInterval(() => void tryTake(), o.pollMs ?? 4000);
    try {
      const off = await o.watch(code.codeId, code.watchToken, () => void tryTake());
      if (settled) off();
      else unwatch = off;
    } catch {
      // No realtime (blocked websocket, proxy): the poll still gets there.
    }

    return {
      display,
      endorsement,
      cancel: () => fail(new EndorseFailedError("cancelled")),
    };
  },
});
