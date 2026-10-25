import { describe, expect, it } from "vitest";
import { parseIcs, parseRule, upcomingMeetings } from "../src/meetings/ics.js";
import {
  formatterCacheSize,
  formattersBuilt,
  tomorrowAt,
  tzOffsetMs,
  zoneAliasCount,
  zonedToUtc,
} from "../src/meetings/tz.js";

const ms = (iso: string) => Date.parse(iso);
const cal = (...events: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap((e) => [
      "BEGIN:VEVENT",
      ...e
        .trim()
        .split("\n")
        .map((l) => l.trim()),
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");
const meetings = (text: string, from: string, to: string, tz = "America/Mexico_City") =>
  upcomingMeetings(parseIcs(text, tz), ms(from), ms(to));

describe("ICS parsing", () => {
  it("reads a UTC event: title unescaped, end, and the join link", () => {
    const text = cal(`
      UID:a1
      SUMMARY:Revisión\\, semanal\\nequipo
      DTSTART:20261026T160000Z
      DTEND:20261026T163000Z
      LOCATION:https://us02web.zoom.us/j/123?pwd=x
    `);
    expect(meetings(text, "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z")).toEqual([
      {
        id: `a1@${ms("2026-10-26T16:00:00Z")}`,
        title: "Revisión, semanal\nequipo",
        startMs: ms("2026-10-26T16:00:00Z"),
        endMs: ms("2026-10-26T16:30:00Z"),
        joinUrl: "https://us02web.zoom.us/j/123?pwd=x",
      },
    ]);
  });

  it("unfolds long lines and finds a Meet link in the description", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:f1",
      "SUMMARY:Una reunión con un título muy largo que el",
      " calendario partió en dos líneas",
      "DTSTART:20261026T160000Z",
      "DURATION:PT45M",
      "DESCRIPTION:Únete: https://meet.google.com/abc-defg-hij",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [m] = meetings(text, "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z");
    expect(m?.title).toBe("Una reunión con un título muy largo que elcalendario partió en dos líneas");
    expect(m?.endMs).toBe(ms("2026-10-26T16:45:00Z"));
    expect(m?.joinUrl).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("uses TZID, maps Windows zone names, and reads floating times in the person's zone", () => {
    const text = cal(
      "UID:t1\nSUMMARY:CDMX\nDTSTART;TZID=America/Mexico_City:20261026T100000\nDTEND;TZID=America/Mexico_City:20261026T110000",
      "UID:t2\nSUMMARY:Outlook\nDTSTART;TZID=Pacific Standard Time:20261026T090000\nDTEND;TZID=Pacific Standard Time:20261026T093000",
      "UID:t3\nSUMMARY:Flotante\nDTSTART:20261026T120000\nDTEND:20261026T123000",
    );
    const got = meetings(text, "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z", "Europe/Madrid");
    expect(got.map((m) => [m.title, new Date(m.startMs).toISOString()])).toEqual([
      ["Flotante", "2026-10-26T11:00:00.000Z"],
      ["CDMX", "2026-10-26T16:00:00.000Z"],
      ["Outlook", "2026-10-26T16:00:00.000Z"],
    ]);
  });

  it("leaves out all-day and cancelled events and ignores a nested alarm", () => {
    const text = cal(
      "UID:d1\nSUMMARY:Feriado\nDTSTART;VALUE=DATE:20261026\nDTEND;VALUE=DATE:20261027",
      "UID:c1\nSUMMARY:Cancelada\nSTATUS:CANCELLED\nDTSTART:20261026T150000Z",
      "UID:k1\nSUMMARY:Con alarma\nDTSTART:20261026T170000Z\nBEGIN:VALARM\nSUMMARY:no soy la reunión\nTRIGGER:-PT10M\nEND:VALARM",
    );
    expect(meetings(text, "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z").map((m) => m.title)).toEqual(["Con alarma"]);
  });

  it("never throws on junk, and skips an event with no start", () => {
    expect(parseIcs("garbage\nBEGIN:VEVENT\nSUMMARY:x\nEND:VEVENT\n:::", "UTC")).toEqual([]);
    expect(parseIcs("", "UTC")).toEqual([]);
  });
});

describe("ICS recurrence", () => {
  it("weekly on Monday and Wednesday keeps 9:00 New York across the DST change (DST-safe)", () => {
    const text = cal(`
      UID:w1
      SUMMARY:Standup
      DTSTART;TZID=America/New_York:20261026T090000
      DTEND;TZID=America/New_York:20261026T091500
      RRULE:FREQ=WEEKLY;BYDAY=MO,WE
    `);
    const got = meetings(text, "2026-10-26T00:00:00Z", "2026-11-05T00:00:00Z");
    expect(got.map((m) => new Date(m.startMs).toISOString())).toEqual([
      "2026-10-26T13:00:00.000Z",
      "2026-10-28T13:00:00.000Z",
      "2026-11-02T14:00:00.000Z", // EDT → EST on Nov 1: same 9:00 wall clock
      "2026-11-04T14:00:00.000Z",
    ]);
    expect(got.every((m) => m.endMs - m.startMs === 15 * 60_000)).toBe(true);
  });

  it("daily with INTERVAL and COUNT, counted from DTSTART", () => {
    const text = cal("UID:d\nSUMMARY:x\nDTSTART:20261020T150000Z\nRRULE:FREQ=DAILY;INTERVAL=2;COUNT=5");
    // 20, 22, 24, 26, 28: only the last two are in the window.
    expect(
      meetings(text, "2026-10-25T00:00:00Z", "2026-11-30T00:00:00Z").map((m) => new Date(m.startMs).toISOString()),
    ).toEqual(["2026-10-26T15:00:00.000Z", "2026-10-28T15:00:00.000Z"]);
  });

  it("UNTIL stops the series, EXDATE removes one, RECURRENCE-ID moves one", () => {
    const text = cal(
      "UID:s\nSUMMARY:Serie\nDTSTART:20261026T150000Z\nDTEND:20261026T160000Z\nRRULE:FREQ=DAILY;UNTIL=20261029T150000Z\nEXDATE:20261027T150000Z",
      "UID:s\nSUMMARY:Serie (movida)\nRECURRENCE-ID:20261028T150000Z\nDTSTART:20261028T180000Z\nDTEND:20261028T183000Z",
    );
    const got = meetings(text, "2026-10-26T00:00:00Z", "2026-11-30T00:00:00Z");
    expect(got.map((m) => [m.title, new Date(m.startMs).toISOString()])).toEqual([
      ["Serie", "2026-10-26T15:00:00.000Z"],
      ["Serie (movida)", "2026-10-28T18:00:00.000Z"],
      ["Serie", "2026-10-29T15:00:00.000Z"],
    ]);
  });

  it("monthly on the second Tuesday and on the last Friday", () => {
    const text = cal(
      "UID:m2\nSUMMARY:2TU\nDTSTART:20260113T170000Z\nRRULE:FREQ=MONTHLY;BYDAY=2TU",
      "UID:mL\nSUMMARY:-1FR\nDTSTART:20260130T170000Z\nRRULE:FREQ=MONTHLY;BYDAY=-1FR",
    );
    const got = meetings(text, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect(got.map((m) => [m.title, new Date(m.startMs).toISOString()])).toEqual([
      ["2TU", "2026-11-10T17:00:00.000Z"],
      ["-1FR", "2026-11-27T17:00:00.000Z"],
    ]);
  });

  it("monthly on the 31st skips short months", () => {
    const text = cal("UID:m31\nSUMMARY:x\nDTSTART:20260131T170000Z\nRRULE:FREQ=MONTHLY");
    expect(
      meetings(text, "2026-02-01T00:00:00Z", "2026-06-01T00:00:00Z").map((m) => new Date(m.startMs).toISOString()),
    ).toEqual(["2026-03-31T17:00:00.000Z", "2026-05-31T17:00:00.000Z"]);
  });

  it("a rule outside the supported subset keeps only its first instance", () => {
    expect(parseRule("FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1", "UTC")).toBe("unsupported");
    expect(parseRule("FREQ=HOURLY", "UTC")).toBe("unsupported");
    const text = cal("UID:u\nSUMMARY:x\nDTSTART:20261026T150000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1");
    expect(meetings(text, "2026-10-01T00:00:00Z", "2027-01-01T00:00:00Z")).toHaveLength(1);
  });
});

describe("zones", () => {
  it("tomorrow at 9:00 in the person's zone, across a DST night", () => {
    expect(new Date(tomorrowAt(ms("2026-10-31T20:00:00Z"), "America/New_York")).toISOString()).toBe(
      "2026-11-01T14:00:00.000Z",
    );
    expect(new Date(tomorrowAt(ms("2026-10-09T05:30:00Z"), "America/Mexico_City")).toISOString()).toBe(
      "2026-10-09T15:00:00.000Z",
    );
  });

  it("a wall time in the spring-forward gap uses the offset before the jump (RFC 5545), on both sides of UTC", () => {
    const at = (h: number, mi: number, tz: string, mo = 3, d = 8) => zonedToUtc({ y: 2026, mo, d, h, mi, s: 0 }, tz);
    expect(new Date(at(2, 30, "America/New_York")).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(new Date(at(3, 30, "America/New_York")).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(new Date(at(2, 30, "Europe/Paris", 3, 29)).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    // Fall back: the repeated hour resolves to its first occurrence.
    expect(new Date(at(1, 30, "America/New_York", 11, 1)).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(new Date(at(2, 30, "Europe/Berlin", 10, 25)).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(new Date(at(2, 30, "Australia/Sydney", 4, 5)).toISOString()).toBe("2026-04-04T15:30:00.000Z");
  });
});

describe("real-world feed shapes", () => {
  it("Google/Outlook-style EXDATE and RECURRENCE-ID with TZID, after the DST change, and a cancelled single occurrence", () => {
    const text = cal(
      [
        "UID:g1",
        "SUMMARY:Standup",
        "DTSTART;TZID=America/New_York:20261026T090000",
        "DTEND;TZID=America/New_York:20261026T091500",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
        "EXDATE;TZID=America/New_York:20261102T090000",
      ].join("\n"),
      [
        "UID:g1",
        "SUMMARY:Standup (movido)",
        "RECURRENCE-ID;TZID=America/New_York:20261104T090000",
        "DTSTART;TZID=America/New_York:20261104T110000",
        "DTEND;TZID=America/New_York:20261104T111500",
      ].join("\n"),
      [
        "UID:g1",
        "SUMMARY:Standup",
        "STATUS:CANCELLED",
        "RECURRENCE-ID;TZID=America/New_York:20261106T090000",
        "DTSTART;TZID=America/New_York:20261106T090000",
      ].join("\n"),
    );
    const got = meetings(text, "2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z");
    expect(got.map((m) => [m.title, new Date(m.startMs).toISOString()])).toEqual([
      ["Standup (movido)", "2026-11-04T16:00:00.000Z"],
    ]);
  });

  it("Windows zone names follow DST, and an unknown zone falls back to the person's", () => {
    const text = cal(
      "UID:w\nSUMMARY:EST\nDTSTART;TZID=Eastern Standard Time:20261102T090000",
      "UID:c\nSUMMARY:Custom\nDTSTART;TZID=Customized Time Zone:20261102T090000",
    );
    const got = meetings(text, "2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z", "America/Mexico_City");
    expect(got.map((m) => [m.title, new Date(m.startMs).toISOString()])).toEqual([
      ["EST", "2026-11-02T14:00:00.000Z"],
      ["Custom", "2026-11-02T15:00:00.000Z"],
    ]);
  });

  it("a floating daily meeting keeps 9:00 in the person's zone across their DST change", () => {
    const text = cal("UID:f\nSUMMARY:x\nDTSTART:20261030T090000\nRRULE:FREQ=DAILY");
    const got = meetings(text, "2026-10-30T00:00:00Z", "2026-11-03T00:00:00Z", "America/New_York");
    expect(got.map((m) => new Date(m.startMs).toISOString())).toEqual([
      "2026-10-30T13:00:00.000Z",
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
    ]);
  });

  it("biweekly with WKST=SU lands on the RFC's weeks (Outlook emits WKST=SU)", () => {
    const text = cal(
      "UID:b\nSUMMARY:x\nDTSTART;TZID=America/New_York:20261027T100000\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU",
    );
    const got = meetings(text, "2026-10-26T00:00:00Z", "2026-11-26T00:00:00Z");
    expect(got.map((m) => new Date(m.startMs).toISOString().slice(0, 10))).toEqual([
      "2026-10-27",
      "2026-11-08",
      "2026-11-10",
      "2026-11-22",
      "2026-11-24",
    ]);
  });

  it("DAILY with BYDAY means weekdays only", () => {
    const text = cal("UID:d\nSUMMARY:x\nDTSTART:20261023T150000Z\nRRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR");
    const got = meetings(text, "2026-10-24T00:00:00Z", "2026-10-28T00:00:00Z");
    expect(got.map((m) => new Date(m.startMs).toISOString().slice(0, 10))).toEqual(["2026-10-26", "2026-10-27"]);
  });

  it("DTSTART off the BYDAY pattern still counts as the first of COUNT", () => {
    // Sunday start, rule on Mondays, COUNT=3: Sun 25, Mon 26, Mon Nov 2.
    const text = cal("UID:c\nSUMMARY:x\nDTSTART:20261025T150000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3");
    const got = meetings(text, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect(got.map((m) => new Date(m.startMs).toISOString().slice(0, 10))).toEqual([
      "2026-10-25",
      "2026-10-26",
      "2026-11-02",
    ]);
  });

  it("join links only on the real Zoom, Meet and Teams hosts", () => {
    const link = (loc: string) =>
      meetings(
        cal(`UID:j\nSUMMARY:x\nDTSTART:20261026T160000Z\nLOCATION:${loc}`),
        "2026-10-26T00:00:00Z",
        "2026-10-27T00:00:00Z",
      )[0]?.joinUrl;
    expect(link("https://evilzoom.us/j/123")).toBeNull();
    expect(link("https://notmeet.google.com/abc")).toBeNull();
    expect(link("https://zoom.us.evil.com/j/1")).toBeNull();
    expect(link("https://acme.zoom.us/j/1")).toBe("https://acme.zoom.us/j/1");
    expect(link("https://teams.microsoft.com/l/meetup-join/x")).toBe("https://teams.microsoft.com/l/meetup-join/x");
  });

  it("300 open-ended series from 2016 expand fast (they took ~9 s before the skip-ahead)", () => {
    const events = Array.from(
      { length: 300 },
      (_, i) =>
        `UID:p${i}\nSUMMARY:s${i}\nDTSTART;TZID=America/New_York:20160104T${String(8 + (i % 10)).padStart(2, "0")}0000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`,
    );
    const parsed = parseIcs(cal(...events), "America/Mexico_City");
    const t0 = performance.now();
    const got = upcomingMeetings(parsed, ms("2026-10-26T00:00:00Z"), ms("2026-10-27T00:00:00Z"));
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(got).toHaveLength(300);
  });
});

describe("hostile feeds (anyone can put an invite on your calendar)", () => {
  const good = "UID:ok\nSUMMARY:Buena\nDTSTART:20261026T160000Z";
  const day = (text: string) => meetings(text, "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z");

  it("a giant INTERVAL is refused and doesn't take the rest of the feed with it", () => {
    expect(parseRule("FREQ=DAILY;INTERVAL=1000000000000", "UTC")).toBe("unsupported");
    expect(parseRule("FREQ=WEEKLY;INTERVAL=1001", "UTC")).toBe("unsupported");
    expect(parseRule("FREQ=WEEKLY;INTERVAL=1000", "UTC")).not.toBe("unsupported");
    const text = cal("UID:x\nSUMMARY:x\nDTSTART:20160101T150000Z\nRRULE:FREQ=YEARLY;INTERVAL=1000000000000", good);
    expect(day(text).map((m) => m.title)).toEqual(["Buena"]);
  });

  it("a giant COUNT is refused, and a large one stays fast", () => {
    expect(parseRule("FREQ=DAILY;COUNT=1000000000", "UTC")).toBe("unsupported");
    const text = cal("UID:c\nSUMMARY:Diaria\nDTSTART:20160101T150000Z\nRRULE:FREQ=DAILY;COUNT=10000", good);
    const t0 = performance.now();
    expect(day(text).map((m) => m.title)).toEqual(["Diaria", "Buena"]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("an event whose dates go non-finite is skipped, the others stay", () => {
    const events = parseIcs(cal("UID:n\nSUMMARY:x\nDTSTART:20160101T150000Z\nRRULE:FREQ=DAILY", good), "UTC");
    events[0]!.wall = { ...events[0]!.wall, y: Number.NaN };
    expect(() => upcomingMeetings(events, ms("2026-10-26T00:00:00Z"), ms("2026-10-27T00:00:00Z"))).not.toThrow();
    expect(
      upcomingMeetings(events, ms("2026-10-26T00:00:00Z"), ms("2026-10-27T00:00:00Z")).map((m) => m.title),
    ).toEqual(["Buena"]);
  });

  it("hundreds of series that never match stay within one poll's budget", () => {
    const slow = Array.from(
      { length: 300 },
      (_, i) => `UID:s${i}\nSUMMARY:s\nDTSTART:20160201T150000Z\nRRULE:FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=30`,
    );
    const parsed = parseIcs(cal(good, ...slow), "UTC");
    const t0 = performance.now();
    const got = upcomingMeetings(parsed, ms("2026-10-26T00:00:00Z"), ms("2026-10-27T00:00:00Z"));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(got.map((m) => m.title)).toContain("Buena");
  });
});

describe("COUNT series jump ahead without changing the answer", () => {
  const rules = [
    "FREQ=DAILY",
    "FREQ=DAILY;INTERVAL=3",
    "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU",
    "FREQ=MONTHLY;BYDAY=1MO,3WE",
    "FREQ=MONTHLY;BYMONTHDAY=5,20",
    "FREQ=MONTHLY",
    "FREQ=YEARLY",
  ];
  const starts = ["20160106T090000", "20190331T023000", "20211107T013000"];
  const zones = ["America/New_York", "Australia/Sydney", "UTC"];

  it("matches a walk from the first instance for every rule, start, zone and COUNT", () => {
    let compared = 0;
    let nonEmpty = 0;
    for (const r of rules)
      for (const s of starts)
        for (const tz of zones)
          for (const count of [3, 50, 400, 1500, 3700, 6000]) {
            const text = cal(`UID:k\nSUMMARY:x\nDTSTART;TZID=${tz}:${s}\nRRULE:${r};COUNT=${count}`);
            const events = parseIcs(text, "UTC");
            const from = ms("2026-10-01T00:00:00Z");
            const to = ms("2026-12-01T00:00:00Z");
            const fast = upcomingMeetings(events, from, to).map((m) => m.startMs);
            const walk = upcomingMeetings(events, events[0]!.startMs - 1, to)
              .map((m) => m.startMs)
              .filter((t) => t >= from);
            expect(fast, `${r} ${s} ${tz} COUNT=${count}`).toEqual(walk);
            compared++;
            if (fast.length) nonEmpty++;
          }
    expect(compared).toBe(rules.length * starts.length * zones.length * 6);
    expect(nonEmpty).toBeGreaterThan(40);
  }, 60_000); // the oracle walks every instance with zone math: seconds on a loaded CI runner
});

describe("review round 3: hostile rule sizes, zone names and the poll budget", () => {
  const good = "UID:ok\nSUMMARY:Buena\nDTSTART:20261026T160000Z";
  const from = ms("2026-10-26T00:00:00Z");
  const to = ms("2026-10-27T00:00:00Z");

  it("a BYDAY list of a million tokens is refused fast, and duplicates collapse", () => {
    const huge = `FREQ=DAILY;COUNT=10000;BYDAY=${Array(1_000_000).fill("MO").join(",")}`;
    const t0 = performance.now();
    expect(parseRule(huge, "UTC")).toBe("unsupported");
    const nth = `FREQ=MONTHLY;COUNT=10000;BYDAY=${Array(400_000).fill("1MO").join(",")},-1MO`;
    expect(parseRule(nth, "UTC")).toBe("unsupported");
    const events = parseIcs(cal(`UID:h\nSUMMARY:x\nDTSTART:20000103T150000Z\nRRULE:${huge}`, good), "UTC");
    expect(upcomingMeetings(events, from, to).map((m) => m.title)).toEqual(["Buena"]);
    expect(performance.now() - t0).toBeLessThan(1500);
    const dup = parseRule("FREQ=WEEKLY;BYDAY=MO,MO,TU,TU", "UTC");
    expect(dup !== "unsupported" && dup.byDay).toEqual([1, 2]);
    const days = parseRule("FREQ=MONTHLY;BYMONTHDAY=5,5,20", "UTC");
    expect(days !== "unsupported" && days.byMonthDay).toEqual([5, 20]);
  });

  it("thousands of letter-case variants of one zone don't grow the formatter cache", () => {
    const name = "America/Mexico_City";
    for (let i = 0; i < 5000; i++) {
      const variant = [...name].map((c, j) => ((i >> (j % 12)) & 1 ? c.toUpperCase() : c.toLowerCase())).join("");
      tzOffsetMs(ms("2026-10-26T00:00:00Z"), variant);
    }
    expect(formatterCacheSize()).toBeLessThanOrEqual(1024);
    expect(zoneAliasCount()).toBeLessThanOrEqual(1024);
  });

  it("the offset memo stays exact around transitions that aren't on a quarter hour", () => {
    const fresh = (t: number, tz: string) => {
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
      const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
      return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
    };
    const cases: [string, string][] = [
      ["America/Goose_Bay", "1990-04-01T04:01:00Z"],
      ["America/Goose_Bay", "1990-10-28T03:01:00Z"],
      ["Africa/Monrovia", "1972-01-07T00:44:30Z"],
      ["America/New_York", "2026-11-01T06:00:00Z"],
    ];
    for (const [tz, at] of cases)
      for (const d of [-60_000, -1000, 0, 1000, 60_000, 14 * 60_000]) {
        const t = ms(at) + d;
        tzOffsetMs(ms(at) - 30_000, tz); // warm the memo for that quarter from inside it first
        expect(tzOffsetMs(t, tz), `${tz} ${new Date(t).toISOString()}`).toBe(fresh(t, tz));
      }
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (const tz of Intl.supportedValuesOf("timeZone"))
      for (let i = 0; i < 20; i++) {
        const t = Math.floor(
          ms("1970-01-01T00:00:00Z") + rand() * (ms("2040-01-01T00:00:00Z") - ms("1970-01-01T00:00:00Z")),
        );
        expect(tzOffsetMs(t, tz), `${tz} ${new Date(t).toISOString()}`).toBe(fresh(t, tz));
      }
  });

  it("4096 case variants of one zone build at most one formatter and stay fast", () => {
    const name = "Pacific/Chatham";
    const built = formattersBuilt();
    const t0 = performance.now();
    for (let i = 0; i < 4096; i++) {
      const variant = [...name].map((c, j) => ((i >> (j % 12)) & 1 ? c.toUpperCase() : c.toLowerCase())).join("");
      tzOffsetMs(ms("2026-10-26T00:00:00Z") + i * 60_000, variant);
    }
    expect(formattersBuilt() - built).toBeLessThanOrEqual(1);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("a feed rotating through 100 real zones keeps every formatter (no cache thrash)", () => {
    const zones = Intl.supportedValuesOf("timeZone").slice(0, 100);
    for (let round = 0; round < 3; round++) for (const z of zones) tzOffsetMs(ms("2026-10-26T00:00:00Z"), z);
    expect(formatterCacheSize()).toBeGreaterThanOrEqual(100);
    const before = formatterCacheSize();
    for (const z of zones) tzOffsetMs(ms("2026-10-26T00:00:00Z"), z.toUpperCase());
    expect(formatterCacheSize()).toBe(before); // case variants reuse the canonical zone's formatter
  });

  it("past one-off events don't starve a recurring series of its budget", () => {
    const oneOffs = Array.from(
      { length: 500 },
      (_, i) => `UID:o${i}\nSUMMARY:viejo\nDTSTART:2025${String((i % 12) + 1).padStart(2, "0")}10T150000Z`,
    );
    const standup =
      "UID:st\nSUMMARY:Standup\nDTSTART:20250602T150000Z\nRRULE:FREQ=DAILY;COUNT=1000;BYDAY=MO,TU,WE,TH,FR";
    const got = upcomingMeetings(parseIcs(cal(standup, ...oneOffs), "UTC"), from, to);
    expect(got.map((m) => m.title)).toEqual(["Standup"]);
  });

  it("a series cut short by its budget, and an event that throws, are counted, not silently dropped", () => {
    const long = "UID:l\nSUMMARY:x\nDTSTART:19500102T150000Z\nRRULE:FREQ=DAILY;COUNT=10000;BYDAY=MO";
    const events = parseIcs(cal(long, "UID:t\nSUMMARY:y\nDTSTART:20261026T170000Z", good), "UTC");
    (events[1] as { exdates: unknown }).exdates = null;
    const stats = { skipped: 0 };
    const got = upcomingMeetings(events, from, to, stats);
    expect(got.map((m) => m.title)).toEqual(["Buena"]);
    expect(stats.skipped).toBe(2);
  });
});
