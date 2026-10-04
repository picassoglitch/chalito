/** POST /v1/rooms/:roomId/members/:companionId/remove (route level; the SQL rules are in pgTAP 32). */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MemoryAudit, type Deps } from "../src/deps.js";
import type { ApiRepo } from "../src/repo.js";
import { RoomError, type RoomsRepo } from "../src/rooms/repo.js";
import { roomsRoutes } from "../src/routes/rooms.js";
import { device, owner } from "./contract/fixtures.js";

const ME = "chl_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const THEM = "chl_bbbbbbbbbbbbbbbbbbbbbbbbbb";

const setup = async (fail?: RoomError) => {
  const o = owner();
  const phone = await device(o, "client");
  const calls: Parameters<RoomsRepo["removeMember"]>[0][] = [];
  const rooms = {
    removeMember: async (a: Parameters<RoomsRepo["removeMember"]>[0]) => {
      calls.push(a);
      if (fail) throw fail;
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
  const post = async (body: unknown, target = THEM, room = "r1") => {
    const res = await app.request(`/v1/rooms/${room}/members/${target}/remove`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return { post, calls, audit, o, phone };
};

describe("room owner removes a member", () => {
  it("204, acts as the verified owner and audits the removal", async () => {
    const s = await setup();
    const r = await s.post({ companionId: ME });
    expect(r.status).toBe(204);
    expect(s.calls).toEqual([{ uid: s.o, companion: ME, roomId: "r1", target: THEM }]);
    expect(s.audit.events).toEqual([
      expect.objectContaining({
        action: "room.member_removed",
        owner: s.o,
        actor: `d_${s.phone.deviceId}`,
        target: "r1",
        meta: { companionId: THEM },
      }),
    ]);
  });

  it("400 for a malformed target or body, without calling the database", async () => {
    const s = await setup();
    expect((await s.post({ companionId: ME }, "not-a-companion")).status).toBe(400);
    expect((await s.post({})).status).toBe(400);
    expect(s.calls).toEqual([]);
  });

  it("the database's refusals come back as HTTP errors and nothing is audited", async () => {
    for (const [err, status] of [
      [new RoomError(403, "only_the_owner_removes_members"), 403],
      [new RoomError(400, "the_owner_dissolves_the_room_instead_of_removing_itself"), 400],
      [new RoomError(404, "member_not_found"), 404],
    ] as const) {
      const s = await setup(err);
      const r = await s.post({ companionId: ME });
      expect(r.status).toBe(status);
      expect(r.json).toMatchObject({ error: err.code });
      expect(s.audit.events).toEqual([]);
    }
  });
});
