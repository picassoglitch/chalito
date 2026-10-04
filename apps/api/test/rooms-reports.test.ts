/** POST /v1/rooms/:roomId/reports (route level; the SQL rules are in pgTAP 31). */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MemoryAudit, type Deps } from "../src/deps.js";
import type { ApiRepo } from "../src/repo.js";
import type { RoomsRepo } from "../src/rooms/repo.js";
import { roomsRoutes } from "../src/routes/rooms.js";
import { device, owner } from "./contract/fixtures.js";

const ME = "chl_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const THEM = "chl_bbbbbbbbbbbbbbbbbbbbbbbbbb";

const setup = async () => {
  const o = owner();
  const phone = await device(o, "client");
  const calls: Parameters<RoomsRepo["report"]>[0][] = [];
  const seen = new Map<string, string>();
  const rooms = {
    report: async (a: Parameters<RoomsRepo["report"]>[0]) => {
      calls.push(a);
      const target = a.eventId ? `event:${a.eventId}` : `member:${a.member}`;
      const prior = seen.get(`${a.uid}/${a.roomId}/${target}`);
      if (prior) return { reportId: prior, duplicate: true };
      seen.set(`${a.uid}/${a.roomId}/${target}`, a.reportId);
      return { reportId: a.reportId, duplicate: false };
    },
  } as unknown as RoomsRepo;
  const audit = new MemoryAudit();
  const deps = {
    repo: {
      getDevice: async (a: string, id: string) => (a === o && id === phone.deviceId ? phone : null),
    } as unknown as ApiRepo,
    identity: {
      verify: async () => ({ uid: `d_${phone.deviceId}`, role: "client", owner: o, deviceId: phone.deviceId }),
    } as unknown as Deps["identity"],
    audit,
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => 1_790_000_000_000,
    rooms,
  };
  const app = new Hono().route("/v1/rooms", roomsRoutes(deps));
  const post = async (body: unknown, room = "r1") => {
    const res = await app.request(`/v1/rooms/${room}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return { post, calls, audit, o };
};

describe("room reports", () => {
  it("201 with a reportId; the same reporter and target again → 200, same id", async () => {
    const s = await setup();
    const a = await s.post({ companionId: ME, eventId: "e1", reason: "spam" });
    expect(a.status).toBe(201);
    expect(a.json).toEqual({ reportId: expect.stringMatching(/^rpt_[0-9a-f]{32}$/), duplicate: false });
    const b = await s.post({ companionId: ME, eventId: "e1", reason: "abuse", note: "again" });
    expect(b).toEqual({ status: 200, json: { reportId: a.json.reportId, duplicate: true } });
    expect(s.audit.events.filter((e) => e.action === "room.reported")).toHaveLength(1);
  });

  it("a member can be reported on its own", async () => {
    const s = await setup();
    expect((await s.post({ companionId: ME, memberCompanionId: THEM, reason: "impersonation" })).status).toBe(201);
    expect(s.calls[0]).toMatchObject({ eventId: null, member: THEM, reason: "impersonation" });
  });

  it("plaintext is kept only with the explicit opt-in, and never goes into the audit log", async () => {
    const s = await setup();
    expect((await s.post({ companionId: ME, eventId: "e1", reason: "abuse", attachedPlaintext: "texto" })).status).toBe(
      400,
    );
    const ok = await s.post({
      companionId: ME,
      eventId: "e2",
      reason: "abuse",
      attachedPlaintext: "texto",
      attachPlaintext: true,
    });
    expect(ok.status).toBe(201);
    expect(s.calls.at(-1)!.plaintext).toBe("texto");
    expect(JSON.stringify(s.audit.events)).not.toContain("texto");
    expect(s.audit.events.at(-1)!.meta).toMatchObject({ plaintextAttached: true });
  });

  it.each([
    [{ companionId: ME, reason: "spam" }, "no target"],
    [{ companionId: ME, eventId: "e1", reason: "hate" }, "unknown reason"],
    [{ companionId: ME, eventId: "e1", reason: "spam", note: "x".repeat(501) }, "note > 500"],
    [
      { companionId: ME, memberCompanionId: THEM, reason: "spam", attachedPlaintext: "t", attachPlaintext: true },
      "plaintext without an event",
    ],
  ] as [Record<string, unknown>, string][])("400: %j (%s)", async (body) => {
    const s = await setup();
    expect((await s.post(body)).status).toBe(400);
    expect(s.calls).toHaveLength(0);
  });

  it("rate-limited per reporter (a burst of 10)", async () => {
    const s = await setup();
    for (let i = 0; i < 10; i++)
      expect((await s.post({ companionId: ME, eventId: `e${i}`, reason: "spam" })).status).toBe(201);
    expect((await s.post({ companionId: ME, eventId: "e10", reason: "spam" })).status).toBe(429);
  });
});
