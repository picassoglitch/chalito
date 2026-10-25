import { validZone, zonedToUtc, type Wall } from "./tz.js";

/** One timed meeting occurrence, the only shape that leaves this module. */
export interface Meeting {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  joinUrl: string | null;
}

type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** The RRULE subset expanded in full; anything else keeps only the first instance. */
export interface Rule {
  freq: Freq;
  interval: number;
  count: number | null;
  untilMs: number | null;
  /** WEEKLY, or DAILY as a filter: weekdays 0-6 (Sunday 0). */
  byDay: number[];
  /** First day of the week (WKST), 0-6; Monday unless the feed says otherwise. */
  wkst: number;
  /** MONTHLY: [ordinal, weekday] like 2TU or -1FR. */
  byNthDay: [number, number][];
  /** MONTHLY: days of the month, positive only. */
  byMonthDay: number[];
}

export interface VEvent {
  uid: string;
  title: string;
  wall: Wall;
  tz: string;
  startMs: number;
  durationMs: number;
  allDay: boolean;
  cancelled: boolean;
  rule: Rule | null;
  /** RRULE present but outside the subset: only DTSTART counts. */
  unsupportedRule: boolean;
  exdates: Set<number>;
  recurrenceIdMs: number | null;
  joinUrl: string | null;
}

// Outlook feeds name zones the Windows way; these are the common ones, the rest fall back to the person's zone.
const WINDOWS_ZONES: Record<string, string> = {
  "Pacific Standard Time": "America/Los_Angeles",
  "Mountain Standard Time": "America/Denver",
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "SA Pacific Standard Time": "America/Bogota",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "E. South America Standard Time": "America/Sao_Paulo",
  "GMT Standard Time": "Europe/London",
  "Romance Standard Time": "Europe/Paris",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central European Standard Time": "Europe/Warsaw",
  UTC: "UTC",
};

const JOIN_RE =
  /https:\/\/(?:[\w-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com)\/[^\s"'<>)\\]+/i;

const unescapeText = (s: string) => s.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

const parseLine = (line: string): Prop | null => {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const [name = "", ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
};

const zoneFor = (tzid: string | undefined, fallback: string): string => {
  if (!tzid) return fallback;
  if (validZone(tzid)) return tzid;
  const mapped = WINDOWS_ZONES[tzid];
  return mapped ?? fallback;
};

const DATE_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/** A DTSTART-like value: its wall clock, zone and instant. Floating times use the person's zone. */
const parseDate = (p: Prop, personTz: string): { wall: Wall; tz: string; ms: number; allDay: boolean } | null => {
  const m = DATE_RE.exec(p.value.trim());
  if (!m) return null;
  const allDay = m[4] === undefined;
  const wall: Wall = {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: allDay ? 0 : Number(m[4]),
    mi: allDay ? 0 : Number(m[5]),
    s: allDay ? 0 : Number(m[6]),
  };
  const tz = m[7] ? "UTC" : zoneFor(p.params.TZID, personTz);
  return { wall, tz, ms: zonedToUtc(wall, tz), allDay };
};

const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const parseDuration = (s: string): number | null => {
  const m = DURATION_RE.exec(s.trim());
  if (!m) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const ms = ((((n(2) * 7 + n(3)) * 24 + n(4)) * 60 + n(5)) * 60 + n(6)) * 1000;
  return m[1] === "-" ? -ms : ms;
};

const MAX_INTERVAL = 1000;
const MAX_COUNT = 10_000;
/** Longest BYDAY / BYMONTHDAY list accepted: 7 weekdays × 5 ordinals, or 31 days, with room for repeats. */
const MAX_LIST = 40;

/** RRULE text → the supported subset, or "unsupported". */
export const parseRule = (value: string, personTz: string): Rule | "unsupported" => {
  if (value.length > 1024) return "unsupported";
  const parts = Object.fromEntries(
    value
      .split(";")
      .map((kv) => kv.split("="))
      .filter((kv): kv is [string, string] => kv.length === 2)
      .map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]),
  );
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return "unsupported";
  const known = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "WKST"]);
  if (Object.keys(parts).some((k) => !known.has(k))) return "unsupported";
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  // Real calendars never come near these; a hostile invite might, to make expansion run away.
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) return "unsupported";
  if (count !== null && (!Number.isInteger(count) || count < 1 || count > MAX_COUNT)) return "unsupported";
  let untilMs: number | null = null;
  if (parts.UNTIL) {
    const u = parseDate({ name: "UNTIL", params: {}, value: parts.UNTIL }, personTz);
    if (!u) return "unsupported";
    // A date-only UNTIL includes that whole day.
    untilMs = u.allDay ? u.ms + 86_400_000 - 1 : u.ms;
  }
  // Work grows with the token count, so a list longer than any real one is refused before it's read.
  const dayToks = parts.BYDAY ? parts.BYDAY.split(",") : [];
  const monthDayToks = parts.BYMONTHDAY ? parts.BYMONTHDAY.split(",") : [];
  if (dayToks.length > MAX_LIST || monthDayToks.length > MAX_LIST) return "unsupported";
  const plainDays = new Set<number>();
  const nthDays = new Map<string, [number, number]>();
  for (const tok of dayToks) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok);
    if (!m) return "unsupported";
    const wd = DAYS.indexOf(m[2] as (typeof DAYS)[number]);
    if (m[1] === undefined) plainDays.add(wd);
    else {
      const n = Number(m[1]);
      if (n === 0 || Math.abs(n) > 5) return "unsupported";
      nthDays.set(`${n}:${wd}`, [n, wd]);
    }
  }
  const byDay = [...plainDays].sort((a, b) => a - b);
  const byNthDay = [...nthDays.values()];
  const wkst = parts.WKST ? DAYS.indexOf(parts.WKST as (typeof DAYS)[number]) : 1;
  if (wkst < 0) return "unsupported";
  const monthDays = new Set<number>();
  for (const tok of monthDayToks) {
    const n = Number(tok);
    if (!Number.isInteger(n) || n < 1 || n > 31) return "unsupported";
    monthDays.add(n);
  }
  const byMonthDay = [...monthDays].sort((a, b) => a - b);
  const weeklyOk = freq === "WEEKLY" && byNthDay.length === 0 && byMonthDay.length === 0;
  const monthlyOk = freq === "MONTHLY" && byDay.length === 0 && !(byNthDay.length && byMonthDay.length);
  const dailyOk = freq === "DAILY" && byNthDay.length === 0 && byMonthDay.length === 0;
  const yearlyOk = freq === "YEARLY" && !parts.BYDAY && !parts.BYMONTHDAY;
  if (!weeklyOk && !monthlyOk && !dailyOk && !yearlyOk) return "unsupported";
  return { freq, interval, count, untilMs, byDay, wkst, byNthDay, byMonthDay };
};

const joinIn = (...fields: (string | undefined)[]): string | null => {
  for (const f of fields) {
    const m = f ? JOIN_RE.exec(f) : null;
    if (m) return m[0];
  }
  return null;
};

/** Calendar text → its VEVENTs. Never throws; a broken event is skipped. */
export const parseIcs = (text: string, personTz: string): VEvent[] => {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out: VEvent[] = [];
  const stack: string[] = [];
  let props: Prop[] = [];
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      stack.push(p.value.toUpperCase());
      if (p.value.toUpperCase() === "VEVENT") props = [];
      continue;
    }
    if (p.name === "END") {
      const ended = stack.pop();
      if (ended === "VEVENT") {
        const ev = toEvent(props, personTz);
        if (ev) out.push(ev);
      }
      continue;
    }
    if (stack[stack.length - 1] === "VEVENT") props.push(p);
  }
  return out;
};

const toEvent = (props: Prop[], personTz: string): VEvent | null => {
  const one = (n: string) => props.find((p) => p.name === n);
  const start = one("DTSTART");
  const s = start ? parseDate(start, personTz) : null;
  if (!s) return null;
  const endProp = one("DTEND");
  const e = endProp ? parseDate(endProp, personTz) : null;
  const dur = one("DURATION");
  const durationMs = e ? e.ms - s.ms : dur ? (parseDuration(dur.value) ?? 0) : 0;
  const ruleProp = one("RRULE");
  const rule = ruleProp ? parseRule(ruleProp.value, personTz) : null;
  const exdates = new Set<number>();
  for (const p of props.filter((x) => x.name === "EXDATE"))
    for (const v of p.value.split(",")) {
      const d = parseDate({ ...p, value: v }, personTz);
      if (d) exdates.add(d.ms);
    }
  const rid = one("RECURRENCE-ID");
  const ridDate = rid ? parseDate(rid, personTz) : null;
  const text = (n: string) => {
    const v = one(n)?.value;
    return v === undefined ? undefined : unescapeText(v);
  };
  return {
    uid: one("UID")?.value.trim() || `${s.ms}`,
    title: (text("SUMMARY") ?? "").trim(),
    wall: s.wall,
    tz: s.tz,
    startMs: s.ms,
    durationMs: Math.max(0, durationMs),
    allDay: s.allDay,
    cancelled: (one("STATUS")?.value ?? "").toUpperCase() === "CANCELLED",
    rule: rule === "unsupported" ? null : rule,
    unsupportedRule: rule === "unsupported",
    exdates,
    recurrenceIdMs: ridDate?.ms ?? null,
    joinUrl: joinIn(text("X-GOOGLE-CONFERENCE"), text("LOCATION"), text("URL"), text("DESCRIPTION")),
  };
};

const MAX_CANDIDATES = 20_000;
const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const weekday = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
const addDays = (w: Wall, n: number): Wall => {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
  return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** The days of one period of `rule`, in order, as wall clocks with DTSTART's time. */
const periodDays = (rule: Rule, start: Wall, k: number): Wall[] => {
  const step = k * rule.interval;
  switch (rule.freq) {
    case "DAILY": {
      const day = addDays(start, step);
      return !rule.byDay.length || rule.byDay.includes(weekday(day.y, day.mo, day.d)) ? [day] : [];
    }
    case "WEEKLY": {
      const sinceWkst = (wd: number) => (wd - rule.wkst + 7) % 7;
      const weekStart = addDays(start, -sinceWkst(weekday(start.y, start.mo, start.d)) + step * 7);
      const days = rule.byDay.length ? rule.byDay : [weekday(start.y, start.mo, start.d)];
      return [...new Set(days)]
        .map(sinceWkst)
        .sort((a, b) => a - b)
        .map((off) => addDays(weekStart, off));
    }
    case "MONTHLY": {
      const base = new Date(Date.UTC(start.y, start.mo - 1 + step, 1));
      const y = base.getUTCFullYear();
      const mo = base.getUTCMonth() + 1;
      const last = daysIn(y, mo);
      let days: number[];
      if (rule.byNthDay.length) {
        days = rule.byNthDay.flatMap(([n, wd]) => {
          const all = Array.from({ length: last }, (_, i) => i + 1).filter((d) => weekday(y, mo, d) === wd);
          const pick = n > 0 ? all[n - 1] : all[all.length + n];
          return pick === undefined ? [] : [pick];
        });
      } else days = rule.byMonthDay.length ? rule.byMonthDay : [start.d];
      return [...new Set(days)]
        .filter((d) => d <= last)
        .sort((a, b) => a - b)
        .map((d) => ({ ...start, y, mo, d }));
    }
    case "YEARLY": {
      const y = start.y + step;
      return start.d <= daysIn(y, start.mo) ? [{ ...start, y }] : [];
    }
  }
};

const DAY_MS = 86_400_000;
/** Candidates one poll may spend across the whole feed; each series gets its fair share of what's left. */
export const POLL_BUDGET = 200_000;
const MIN_SHARE = 200;
/** This many periods in a row with no day at all means the rule never matches (e.g. Feb 30). */
const MAX_EMPTY_RUN = 400;

/** A period index a little before `fromMs`, so a series from years ago doesn't walk every week since. */
const periodsBefore = (rule: Rule, startMs: number, fromMs: number): number => {
  if (fromMs <= startMs) return 0;
  const days = (fromMs - startMs) / DAY_MS;
  const perPeriod = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[rule.freq] * rule.interval;
  return Math.max(0, Math.floor(days / perPeriod) - 1);
};

/** Instances in every period after the first, when that number never varies; null when it does. */
const perPeriod = (rule: Rule, start: Wall): number | null => {
  if (rule.freq === "DAILY") return rule.byDay.length ? null : 1;
  if (rule.freq === "WEEKLY") return Math.max(1, new Set(rule.byDay).size);
  if (rule.freq === "YEARLY") return start.mo === 2 && start.d === 29 ? null : 1;
  if (rule.byNthDay.length) {
    const ok = rule.byNthDay.every(([n]) => n >= 1 && n <= 4);
    return ok ? new Set(rule.byNthDay.map(([n, wd]) => `${n}:${wd}`)).size : null;
  }
  const days = rule.byMonthDay.length ? rule.byMonthDay : [start.d];
  return days.every((d) => d <= 28) ? new Set(days).size : null;
};

/** Where to start walking and how many instances came before: open-ended rules jump near the window, and
 * COUNT rules jump too when every period holds the same number of instances. */
const startPoint = (ev: VEvent, rule: Rule, fromMs: number): { k: number; produced: number } => {
  const k = periodsBefore(rule, ev.startMs, fromMs);
  if (k < 1) return { k: 0, produced: 1 };
  if (rule.count === null) return { k, produced: 1 };
  const c = perPeriod(rule, ev.wall);
  if (c === null) return { k: 0, produced: 1 };
  const firstAfterStart = periodDays(rule, ev.wall, 0).filter((w) => zonedToUtc(w, ev.tz) > ev.startMs).length;
  return { k, produced: 1 + firstAfterStart + (k - 1) * c };
};

/** Instants of one series that may fall in [fromMs, toMs]. DTSTART is always the first and counts toward COUNT
 * (RFC 5545); wall dates a day clear of the window skip the zone math. */
const instances = (
  ev: VEvent,
  fromMs: number,
  toMs: number,
  allowance: number,
): { out: number[]; spent: number; truncated: boolean } => {
  if (!ev.rule) return { out: [ev.startMs], spent: 0, truncated: false };
  const rule = ev.rule;
  const out: number[] = [ev.startMs];
  const begin = startPoint(ev, rule, fromMs);
  let produced = begin.produced;
  let seen = 0;
  let emptyRun = 0;
  const done = (truncated = false) => ({ out, spent: seen, truncated });
  for (let k = begin.k; ; k++) {
    if (seen >= Math.min(MAX_CANDIDATES, allowance)) return done(true);
    if (rule.count !== null && produced >= rule.count) return done();
    const days = periodDays(rule, ev.wall, k);
    seen += Math.max(1, days.length);
    emptyRun = days.length ? 0 : emptyRun + 1;
    if (emptyRun >= MAX_EMPTY_RUN) return done(true);
    for (const w of days) {
      const rough = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
      if (!Number.isFinite(rough)) return done(true);
      if (rough < ev.startMs - DAY_MS) continue;
      if (rough > toMs + DAY_MS || (rule.untilMs !== null && rough > rule.untilMs + DAY_MS)) return done();
      if (rule.count !== null && produced >= rule.count) return done();
      if (rough > ev.startMs + DAY_MS && rough < fromMs - DAY_MS) {
        produced++;
        continue;
      }
      const ms = zonedToUtc(w, ev.tz);
      if (ms <= ev.startMs) continue;
      if (ms > toMs || (rule.untilMs !== null && ms > rule.untilMs)) return done();
      produced++;
      out.push(ms);
    }
  }
};

/** Timed meetings starting in [fromMs, toMs), sorted; no all-day or cancelled ones. RECURRENCE-ID overrides
 * replace their instance; EXDATEs remove theirs. `stats.skipped` counts events left out (cut short or broken). */
export const upcomingMeetings = (
  events: VEvent[],
  fromMs: number,
  toMs: number,
  stats: { skipped: number } = { skipped: 0 },
): Meeting[] => {
  const overrides = new Map<string, VEvent>();
  for (const ev of events) if (ev.recurrenceIdMs !== null) overrides.set(`${ev.uid}@${ev.recurrenceIdMs}`, ev);
  const out: Meeting[] = [];
  const push = (ev: VEvent, startMs: number, id: string) => {
    if (ev.cancelled || ev.allDay || startMs < fromMs || startMs >= toMs) return;
    out.push({ id, title: ev.title, startMs, endMs: startMs + ev.durationMs, joinUrl: ev.joinUrl });
  };
  const series = events.filter((ev) => ev.recurrenceIdMs === null);
  // Only recurring series spend the budget, so one-off events never shrink a series' share.
  let recurringLeft = series.filter((ev) => ev.rule).length;
  let left = POLL_BUDGET;
  for (const ev of series) {
    // An invite anyone can send is untrusted: one that throws or runs out of budget is counted and skipped.
    try {
      let starts: number[];
      if (ev.rule) {
        const share = Math.max(MIN_SHARE, Math.floor(left / recurringLeft--));
        const r = instances(ev, fromMs, toMs, Math.min(share, left));
        left = Math.max(0, left - r.spent);
        if (r.truncated) stats.skipped++;
        starts = r.out;
      } else starts = [ev.startMs];
      for (const ms of starts) {
        if (ev.exdates.has(ms)) continue;
        const id = `${ev.uid}@${ms}`;
        const o = overrides.get(id);
        if (o) {
          overrides.delete(id);
          push(o, o.startMs, id);
        } else push(ev, ms, id);
      }
    } catch {
      stats.skipped++;
    }
  }
  // Overrides whose series we didn't expand (unsupported rule, or moved into the window) still count.
  for (const [id, o] of overrides) push(o, o.startMs, id);
  return out.sort((a, b) => a.startMs - b.startMs);
};
