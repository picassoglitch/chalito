import type { SecretStore } from "../secrets.js";
import { parseIcs, upcomingMeetings, type Meeting, type VEvent } from "./ics.js";

/** Keychain entry for the pasted calendar link: a private iCal URL is a password in disguise. */
export const CALENDAR_SECRET = "calendar-ics-url";

const CACHE_MS = 5 * 60_000;
const RETRY_MS = 60_000;
const AHEAD_MS = 24 * 3600_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Under the desktop's 15 s IPC read timeout with room for the call check, so a hung host can't look like a dead agent. */
export const READ_TIMEOUT_MS = 8_000;

export type CalendarError = "fetch_failed" | "link_rejected" | "not_calendar" | "too_large" | "local_address";
export interface Upcoming {
  configured: boolean;
  meetings: Meeting[];
  /** The last read failed; `meetings` come from the last good copy, if any. */
  error: CalendarError | null;
  /** Repeating meetings whose rule this reader can't expand: they won't be warned about. */
  unsupported: number;
}

/** `webcal://` is how calendar apps hand out the same https link. Anything but https is refused. */
export const normalizeCalendarUrl = (raw: string): string | null => {
  const s = raw.trim().replace(/^webcals?:\/\//i, "https://");
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname ? u.toString() : null;
  } catch {
    return null;
  }
};

export interface CalendarDeps {
  secrets: SecretStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** The person's zone, for floating times in the feed. */
  tz?: () => string;
  /** Read failures, for the agent log. Never given the link: it's a secret. */
  warn?: (event: string, meta: Record<string, unknown>) => void;
}

const v4Local = (a: number[]): boolean => {
  const [x = -1, y = -1] = a;
  return (
    x === 0 ||
    x === 10 ||
    x === 127 ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 100 && y >= 64 && y <= 127)
  );
};

/** Loopback, link-local, private and unspecified hosts given as names or IP literals. A public name that
 * resolves to a private address isn't caught here; that needs the resolver. */
export const localHost = (hostname: string): boolean => {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return v4Local(v4.slice(1).map(Number));
  if (!h.includes(":")) return false;
  // IPv4 carried inside IPv6: v4-mapped ::ffff:0:0/96, v4-compatible ::/96 and NAT64 64:ff9b::/96.
  const embedded =
    /^(?:::ffff:|::|64:ff9b::)(?:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(h);
  if (embedded) {
    if (embedded[1] !== undefined) return v4Local(embedded.slice(1, 5).map(Number));
    const hi = parseInt(embedded[5]!, 16);
    return v4Local([hi >> 8, hi & 255, parseInt(embedded[6]!, 16) >> 8]);
  }
  return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
};

/** The body, or null as soon as it passes `max` bytes (a chunked reply has no length to check first). */
const readCapped = async (r: Response, max: number): Promise<Uint8Array | null> => {
  if (!r.body) return new Uint8Array();
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

type ReadResult = string | { error: CalendarError; cause: string; status?: number };

/** Reads the person's calendar feed (read-only) and keeps the parsed events in memory only. */
export class CalendarService {
  #events: VEvent[] | null = null;
  #okAt = 0;
  #lastError: CalendarError | null = null;
  #retryAt = 0;
  #inflight: Promise<void> | null = null;
  #gen = 0;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #tz: () => string;

  constructor(private readonly d: CalendarDeps) {
    this.#fetch = d.fetch ?? fetch;
    this.#now = d.now ?? Date.now;
    this.#tz = d.tz ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  async configured(): Promise<boolean> {
    return (await this.d.secrets.get(CALENDAR_SECRET)) !== null;
  }

  /** Saves the link after one test read, so a wrong paste is caught here and not at the next meeting. */
  async setUrl(raw: string): Promise<{ ok: true } | { ok: false; reason: "bad_url" | "keychain" | CalendarError }> {
    const url = normalizeCalendarUrl(raw);
    if (!url) return { ok: false, reason: "bad_url" };
    const got = await this.#read(url);
    if (typeof got !== "string") return { ok: false, reason: got.error };
    try {
      await this.d.secrets.set(CALENDAR_SECRET, url);
    } catch (err) {
      this.d.warn?.("calendar.keychain_failed", { error: err instanceof Error ? err.message : "error" });
      return { ok: false, reason: "keychain" };
    }
    this.#gen++;
    this.#store(got);
    return { ok: true };
  }

  async clear(): Promise<void> {
    await this.d.secrets.delete(CALENDAR_SECRET);
    this.#gen++;
    this.#events = null;
    this.#lastError = null;
    this.#retryAt = 0;
  }

  /** Answers from memory; a stale copy refreshes in the background so a slow host never blocks the panel. */
  async upcoming(): Promise<Upcoming> {
    const url = await this.d.secrets.get(CALENDAR_SECRET);
    if (!url) return { configured: false, meetings: [], error: null, unsupported: 0 };
    const now = this.#now();
    const stale = !this.#events || now - this.#okAt >= CACHE_MS;
    if (stale && now >= this.#retryAt && !this.#inflight)
      this.#inflight = this.#refresh(url).finally(() => (this.#inflight = null));
    // Nothing to show yet: the first read is worth waiting for (bounded by READ_TIMEOUT_MS).
    if (!this.#events && this.#inflight) await this.#inflight;
    const events = this.#events ?? [];
    const stats = { skipped: 0 };
    const meetings = upcomingMeetings(events, now - 60_000, now + AHEAD_MS, stats);
    const unreadable = events.filter((e) => e.unsupportedRule && e.recurrenceIdMs === null && !e.cancelled).length;
    return { configured: true, meetings, error: this.#lastError, unsupported: unreadable + stats.skipped };
  }

  /** Resolves when no read is running (tests and callers that just saved a link). */
  async settled(): Promise<void> {
    await this.#inflight;
  }

  async #refresh(url: string): Promise<void> {
    const gen = this.#gen;
    const got = await this.#read(url);
    // The link was replaced or removed while this read ran: its answer is about a calendar that's gone.
    if (gen !== this.#gen) return;
    if (typeof got === "string") return this.#store(got);
    this.#lastError = got.error;
    this.#retryAt = this.#now() + RETRY_MS;
    this.d.warn?.("calendar.read_failed", { cause: got.cause, ...(got.status ? { status: got.status } : {}) });
  }

  #store(text: string) {
    this.#events = parseIcs(text, this.#tz());
    this.#okAt = this.#now();
    this.#lastError = null;
    this.#retryAt = 0;
  }

  /** Follows redirects by hand so the link never leaves https. */
  async #read(url: string): Promise<ReadResult> {
    // The first hop gets the same local-network refusal as every redirect, on save and on each poll.
    if (!URL.canParse(url)) return { error: "fetch_failed", cause: "bad_url" };
    if (localHost(new URL(url).hostname)) return { error: "local_address", cause: "local_address" };
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
    let at = url;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const r = await this.#fetch(at, { signal, redirect: "manual" });
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers.get("location");
          const next = loc ? new URL(loc, at) : null;
          await r.body?.cancel().catch(() => undefined);
          if (next?.protocol !== "https:" || localHost(next.hostname))
            return { error: "fetch_failed", cause: "insecure_redirect", status: r.status };
          at = next.toString();
          continue;
        }
        const fail = (e: { error: CalendarError; cause: string; status?: number }) =>
          r.body
            ? r.body.cancel().then(
                () => e,
                () => e,
              )
            : Promise.resolve(e);
        if ([401, 403, 404, 410].includes(r.status))
          return fail({ error: "link_rejected", cause: "http", status: r.status });
        if (!r.ok) return fail({ error: "fetch_failed", cause: "http", status: r.status });
        if (Number(r.headers.get("content-length") ?? 0) > MAX_BYTES)
          return fail({ error: "too_large", cause: "size" });
        const body = await readCapped(r, MAX_BYTES);
        if (!body) return { error: "too_large", cause: "size" };
        const text = new TextDecoder().decode(body);
        return /BEGIN:VCALENDAR/i.test(text.slice(0, 4096)) ? text : { error: "not_calendar", cause: "body" };
      }
      return { error: "fetch_failed", cause: "redirects" };
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return { error: "fetch_failed", cause: timeout ? "timeout" : "network" };
    }
  }
}
