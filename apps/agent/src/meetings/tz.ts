/** Wall-clock fields, months 1-12. */
export interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

// Zone names come from calendar feeds (untrusted): formatters are keyed by Intl's canonical name, so the cache
// is bounded by the ~600 real zones; spellings map to it through an alias table that is capped too.
const MAX_ZONES = 1024;
const fmt = new Map<string, Intl.DateTimeFormat>();
const aliases = new Map<string, string>();
export const formatterCacheSize = (): number => fmt.size;
export const zoneAliasCount = (): number => aliases.size;
let built = 0;
/** How many formatters were ever constructed (each costs real time; a test watches it). */
export const formattersBuilt = (): number => built;
const remember = <V>(m: Map<string, V>, k: string, v: V) => {
  if (m.size >= MAX_ZONES) m.delete(m.keys().next().value!);
  m.set(k, v);
};
// Intl ignores case in zone names, so every spelling of one zone shares a single lower-cased alias.
const formatter = (tz: string) => {
  const spelling = tz.toLowerCase();
  const canonical = aliases.get(spelling);
  const hit = canonical === undefined ? undefined : fmt.get(canonical);
  if (hit) return hit;
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  built++;
  const name = f.resolvedOptions().timeZone;
  remember(aliases, spelling, name);
  const shared = fmt.get(name);
  if (shared) return shared;
  remember(fmt, name, f);
  return f;
};

const canonicalZone = (tz: string): string => {
  const known = aliases.get(tz.toLowerCase());
  return known !== undefined && fmt.has(known) ? known : formatter(tz).resolvedOptions().timeZone;
};

export const validZone = (tz: string): boolean => {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
};

// One offset per zone and quarter hour turns a big feed's repeated formatToParts calls into map hits. A quarter
// is cached only when both ends agree; one holding a transition (some fall off :00/:15, e.g. Goose Bay at :01) stays exact (NaN).
const QUARTER_MS = 15 * 60_000;
const MAX_OFFSETS = 100_000;
const offsets = new Map<string, number>();

/** Offset of `tz` from UTC at instant `ms`. */
export const tzOffsetMs = (ms: number, tz: string): number => {
  if (!Number.isFinite(ms)) return rawOffset(ms, tz);
  // Keyed by the canonical zone, so spellings of one zone share their memo entries.
  const zone = canonicalZone(tz);
  const q = Math.floor(ms / QUARTER_MS);
  const key = `${zone}|${q}`;
  let off = offsets.get(key);
  if (off === undefined) {
    const a = rawOffset(q * QUARTER_MS, zone);
    off = a === rawOffset(q * QUARTER_MS + QUARTER_MS - 1000, zone) ? a : Number.NaN;
    if (offsets.size >= MAX_OFFSETS) offsets.clear();
    offsets.set(key, off);
  }
  return Number.isNaN(off) ? rawOffset(ms, zone) : off;
};

const rawOffset = (ms: number, tz: string): number => {
  const p = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(ms))
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
};

const sameWall = (ms: number, w: Wall, tz: string) => {
  const g = utcToWall(ms, tz);
  return g.y === w.y && g.mo === w.mo && g.d === w.d && g.h === w.h && g.mi === w.mi && g.s === w.s;
};

/** The instant a wall-clock time in `tz` names (RFC 5545 §3.3.5): a repeated hour is its first occurrence,
 * a skipped one uses the offset in force before the jump (02:30 New York that night is 03:30 EDT). */
export const zonedToUtc = (w: Wall, tz: string): number => {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const before = guess - tzOffsetMs(guess - 36 * 3600_000, tz);
  const after = guess - tzOffsetMs(guess + 36 * 3600_000, tz);
  if (before === after) return before;
  const here = guess - tzOffsetMs(guess, tz);
  const exact = [before, after, here].filter((t) => sameWall(t, w, tz));
  return exact.length ? Math.min(...exact) : before;
};

/** The wall clock in `tz` at instant `ms`. */
export const utcToWall = (ms: number, tz: string): Wall => {
  const d = new Date(ms + tzOffsetMs(ms, tz));
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
};

/** Tomorrow at `hour`:00 in `tz`, as an instant (the "Luego" time). */
export const tomorrowAt = (nowMs: number, tz: string, hour = 9): number => {
  const w = utcToWall(nowMs, tz);
  const next = new Date(Date.UTC(w.y, w.mo - 1, w.d + 1));
  return zonedToUtc(
    { y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate(), h: hour, mi: 0, s: 0 },
    tz,
  );
};
