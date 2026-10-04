import fc from "fast-check";
import { NotificationSource, OutboundTemplateVars, type Level, type Urgency } from "@chalito/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_ESCALATION } from "../src/config.js";
import { inQuietHours, localDate } from "../src/time.js";
import type { EscalationEvent, EscalationItem, UserPrefs } from "../src/types.js";
import { MIN, NOON_MX, simulate } from "./sim.js";

/** Text a producer might mistakenly attach; it must never reach an outbound channel. */
const SECRET = "SECRET-sudo rm -rf ~/prod migrations";

const TZS = ["America/Mexico_City", "America/New_York", "Europe/Madrid", "Asia/Tokyo"];
const LEVELS: Level[] = ["L0", "L1", "L2", "L3", "L4"];
const URGENCIES: Urgency[] = ["low", "normal", "high", "critical"];
const SOURCES = NotificationSource.options;

const prefsArb: fc.Arbitrary<UserPrefs> = fc.record({
  tz: fc.constantFrom(...TZS),
  locale: fc.constantFrom("es" as const, "en" as const),
  quietHours: fc.option(
    fc.constantFrom(
      { start: "23:00", end: "07:00" },
      { start: "21:30", end: "08:15" },
      { start: "01:00", end: "05:00" },
    ),
    {
      nil: undefined,
    },
  ),
  phone: fc.record({
    e164: fc.constant("+525512345678"),
    country: fc.constantFrom("MX", "US", "ES"),
    verified: fc.boolean(),
    chargesNoticeAckAt: fc.option(fc.constant(1), { nil: null }),
  }),
  whatsapp: fc.record({ optIn: fc.boolean() }),
  calls: fc.record({ enabled: fc.boolean() }),
  sms: fc.option(fc.record({ enabled: fc.boolean() }), { nil: undefined }),
  l4QuietOverride: fc.subarray(SOURCES, { maxLength: 3 }),
});

type Step = { at: number; event: EscalationEvent; presence?: { desktopActive: boolean } };

/** Up to 14 events over ~3 days: notifies (unique nids, a few coalesce keys), acks, snoozes. */
const stepsArb: fc.Arbitrary<Step[]> = fc
  .array(
    fc.record({
      offsetMin: fc.integer({ min: 0, max: 72 * 60 }),
      kind: fc.constantFrom("notify", "notify", "notify", "ack", "snooze", "expire"),
      key: fc.integer({ min: 0, max: 3 }),
      source: fc.constantFrom(...SOURCES),
      level: fc.constantFrom(...LEVELS),
      urgency: fc.constantFrom(...URGENCIES),
      n: fc.integer({ min: 0, max: 20 }),
      ackAll: fc.boolean(),
      desktopActive: fc.boolean(),
    }),
    { maxLength: 14 },
  )
  .map((raw) =>
    raw.map((r, i): Step => {
      const at = NOON_MX + r.offsetMin * MIN;
      const nid = `n${i}`;
      const target = `k${r.key}`;
      const presence = { desktopActive: r.desktopActive };
      if (r.kind === "notify") {
        const item = {
          nid,
          source: r.source,
          urgency: r.urgency,
          level: r.level,
          counts: { approvals: r.n % 3, questions: r.n, messages: r.n * 2, mesas: r.n % 2 },
          coalesceKey: `${target}:${SECRET}`,
          deepLink: "/s/s1",
          createdAt: at,
          ...(r.source === "approval" ? { approvalExpiresAt: at + 10 * MIN } : {}),
          ...(r.source === "mesa_starting" ? { mesaStartsAt: at + 20 * MIN } : {}),
          // A producer bug: content smuggled in an extra field.
          title: SECRET,
        } as EscalationItem;
        return { at, event: { type: "notify", item }, presence };
      }
      if (r.kind === "ack")
        return {
          at,
          event: r.ackAll
            ? { type: "ack", via: "app", all: true }
            : { type: "ack", via: "push", coalesceKey: `${target}:${SECRET}` },
          presence,
        };
      // Snooze/expire the ladder opened by the latest notify on that key (or nothing).
      const nid2 = `n${raw.findLastIndex((x, j) => j < i && x.kind === "notify" && x.key === r.key)}`;
      return {
        at,
        event: r.kind === "snooze" ? { type: "snooze", nid: nid2 } : { type: "approval_expired", nid: nid2 },
        presence,
      };
    }),
  );

const run = (prefs: UserPrefs, steps: Step[]) => simulate(prefs, steps);

describe("escalation properties", () => {
  it("no calls in quiet hours unless the item is an allowlisted L4", () => {
    fc.assert(
      fc.property(prefsArb, stepsArb, (prefs, steps) => {
        const quiet = prefs.quietHours === undefined ? DEFAULT_ESCALATION.quietHoursDefault : prefs.quietHours;
        for (const s of run(prefs, steps).sends) {
          if (s.action.type !== "send" || s.action.channel !== "call" || !quiet) continue;
          if (inQuietHours(s.at, prefs.tz, quiet)) {
            expect(s.item?.level).toBe("L4");
            expect(prefs.l4QuietOverride).toContain(s.item?.source);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("daily caps are never exceeded (per channel, per local day), even under load", () => {
    // Every channel on and no quiet hours, so the caps are what stops the ladder.
    const open = (p: UserPrefs): UserPrefs => ({
      ...p,
      quietHours: null,
      phone: { e164: "+14155550100", country: "US", verified: true, chargesNoticeAckAt: 1 },
      whatsapp: { optIn: true },
      calls: { enabled: true },
      sms: { enabled: true },
    });
    const loadArb = fc.array(fc.integer({ min: 0, max: 36 * 60 }), { minLength: 4, maxLength: 20 }).map((mins) =>
      mins.map((m, i): Step => ({
        at: NOON_MX + m * MIN,
        event: {
          type: "notify",
          item: {
            nid: `n${i}`,
            source: "session_question",
            urgency: "high",
            level: "L4",
            counts: { approvals: 0, questions: 1, messages: 0, mesas: 0 },
            coalesceKey: `k${i}`,
            deepLink: "/s/s1",
            createdAt: NOON_MX + m * MIN,
          },
        },
      })),
    );
    let reached = 0;
    fc.assert(
      fc.property(prefsArb, loadArb, (prefs, steps) => {
        const p = open(prefs);
        const perDay = new Map<string, number>();
        for (const s of run(p, steps).sends) {
          if (s.action.type !== "send" || !["call", "whatsapp", "sms"].includes(s.action.channel)) continue;
          const ch = s.action.channel as "call" | "whatsapp" | "sms";
          const k = `${ch}:${localDate(s.at, p.tz)}`;
          perDay.set(k, (perDay.get(k) ?? 0) + 1);
          expect(perDay.get(k)!).toBeLessThanOrEqual(DEFAULT_ESCALATION.caps[ch]);
          if (perDay.get(k) === DEFAULT_ESCALATION.caps[ch]) reached++;
        }
      }),
      { numRuns: 200 },
    );
    expect(reached).toBeGreaterThan(0); // the property was actually exercised
  }, 30_000);

  it("any ack cancels all pending steps: nothing more is sent for a ladder opened before it", () => {
    let checked = 0;
    fc.assert(
      fc.property(prefsArb, stepsArb, (prefs, steps) => {
        const { sends } = run(prefs, steps);
        const sorted = [...steps].sort((a, b) => a.at - b.at);
        for (const ack of sorted) {
          if (ack.event.type !== "ack") continue;
          const ev = ack.event;
          // Judged from the inputs alone: every notify before the ack on a matching key.
          const covered = sorted.filter(
            (n) =>
              n.event.type === "notify" && n.at < ack.at && (ev.all || n.event.item.coalesceKey === ev.coalesceKey),
          );
          for (const n of covered) {
            if (n.event.type !== "notify") continue;
            const nid = n.event.item.nid;
            const late = sends.filter((s) => s.action.type === "send" && s.action.nid === nid && s.at > ack.at);
            expect(late.map((s) => s.action.type === "send" && `${s.action.channel}@${s.at}`)).toEqual([]);
            checked++;
          }
        }
      }),
      { numRuns: 300 },
    );
    expect(checked).toBeGreaterThan(0);
  });

  it("outbound payloads carry only counts, type and urgency (no smuggled text)", () => {
    const PUSH_KEYS = new Set(["nid", "level", "source", "urgency", "counts", "total", "deepLink", "notice"]);
    const TEMPLATE_KEYS = ["linkId", "locale", "source", "template", "total", "urgency"];
    fc.assert(
      fc.property(prefsArb, stepsArb, (prefs, steps) => {
        for (const s of run(prefs, steps).sends) {
          if (s.action.type !== "send") continue;
          expect(JSON.stringify(s.action)).not.toContain("SECRET");
          if (s.action.channel === "whatsapp" || s.action.channel === "sms") {
            expect(OutboundTemplateVars.safeParse(s.action.payload).success).toBe(true);
            expect(Object.keys(s.action.payload).sort()).toEqual(TEMPLATE_KEYS);
          } else if (s.action.channel === "push" || s.action.channel === "desktop") {
            for (const k of Object.keys(s.action.payload)) expect(PUSH_KEYS.has(k)).toBe(true);
            expect(Object.keys(s.action.payload.counts).sort()).toEqual([
              "approvals",
              "mesas",
              "messages",
              "questions",
            ]);
          } else {
            expect(Object.keys(s.action.payload)).toEqual(["nid"]);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("an approval ladder never sends after its expiry notice", () => {
    fc.assert(
      fc.property(prefsArb, stepsArb, (prefs, steps) => {
        const { log } = run(prefs, steps);
        const expired = new Map<string, number>();
        for (const l of log) {
          if (l.action.type === "ladder" && l.action.ladder.state === "expired")
            expired.set(l.action.ladder.item.nid, l.at);
          if (l.action.type === "send" && expired.has(l.action.nid))
            expect(l.at).toBeLessThanOrEqual(expired.get(l.action.nid)!);
          if (
            l.action.type === "send" &&
            l.item?.approvalExpiresAt !== undefined &&
            l.action.payload &&
            !("notice" in l.action.payload)
          )
            expect(l.at).toBeLessThan(l.item.approvalExpiresAt + 1);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(prefsArb, stepsArb, (prefs, steps) => {
        expect(JSON.stringify(run(prefs, steps).log)).toBe(JSON.stringify(run(prefs, steps).log));
      }),
      { numRuns: 50 },
    );
  });
});
