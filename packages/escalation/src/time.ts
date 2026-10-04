/** Local wall-clock parts in an IANA time zone (pure; no host-tz dependence). */
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (tz: string) => {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
};

const parts = (now: number, tz: string) => {
  const p = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(now))
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
    second: Number(p.second),
  };
};

const toMinutes = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`bad time ${hhmm}`);
  return (Number(m[1]) % 24) * 60 + (Number(m[2]) % 60);
};

/** The user's local calendar date (YYYY-MM-DD): the unit for daily caps. */
export const localDate = (now: number, tz: string) => parts(now, tz).date;

/** Inside [start, end) in the user's tz; the window may cross midnight. start == end: never. */
export const inQuietHours = (now: number, tz: string, q: { start: string; end: string }) => {
  const m = parts(now, tz).minute;
  const s = toMinutes(q.start);
  const e = toMinutes(q.end);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
};

/** The next instant the local clock reads `end` (at most 24 h ahead). */
export const quietHoursEnd = (now: number, tz: string, q: { start: string; end: string }) => {
  const p = parts(now, tz);
  const delta = (toMinutes(q.end) - p.minute + 1440) % 1440 || 1440;
  return now - (now % 1000) - p.second * 1000 + delta * 60_000;
};
