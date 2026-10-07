import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MemoryAudit, type Deps } from "../src/deps.js";
import { hashRecoveryCode } from "../src/lib/recovery.js";
import type { ApiRepo, StoredRecovery } from "../src/repo.js";
import { recoveryRoutes } from "../src/routes/recovery.js";

const CODE = "ABCDE-FGHJK-MNPQR-STVWX-YZ0123";
const COOLDOWN = 60 * 60 * 1000;

const setup = async () => {
  const o = "hub-user-1";
  let rec: StoredRecovery | null = { ...(await hashRecoveryCode(CODE)), cooldownUntil: null };
  const notifications: string[] = [];
  let clock = 1_790_000_000_000;
  const repo: Partial<ApiRepo> = {
    getRecovery: async () => rec,
    startRecovery: async (_o, cooldownUntil) => {
      rec = { ...rec!, cooldownUntil };
    },
    createNotification: async (_o, nid) => void notifications.push(nid),
  };
  const audit = new MemoryAudit();
  const deps = {
    repo,
    identity: { verify: async () => ({ uid: o, role: "user", owner: o }) },
    audit,
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: COOLDOWN, skewMs: 60_000 },
    now: () => clock,
  } as unknown as Deps;
  const app = new Hono().route("/v1/recovery", recoveryRoutes(deps));
  const start = async (code = CODE) => {
    const res = await app.request("/v1/recovery/start", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer person" },
      body: JSON.stringify({ recoveryCode: code }),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as { cooldownUntil?: number } | null };
  };
  return { start, notifications, audit, tick: (ms: number) => (clock += ms), now: () => clock };
};

describe("POST /v1/recovery/start", () => {
  it("alerts every device once; a retry during the cool-down keeps the end time and doesn't alert again", async () => {
    const t = await setup();
    const first = await t.start();
    expect(first.status).toBe(200);
    const until = first.json!.cooldownUntil!;
    expect(until).toBe(t.now() + COOLDOWN);
    expect(t.notifications).toHaveLength(1);

    t.tick(5 * 60 * 1000);
    const again = await t.start();
    expect(again.status).toBe(200);
    expect(again.json!.cooldownUntil).toBe(until);
    expect(t.notifications).toHaveLength(1);
    expect(t.audit.events.map((e) => e.action)).toEqual(["recovery.started", "recovery.retried"]);
  });

  it("a wrong code never starts the cool-down or alerts", async () => {
    const t = await setup();
    expect((await t.start("ABCDE-FGHJK-MNPQR-STVWX-YZ0999")).status).toBe(401);
    expect(t.notifications).toHaveLength(0);
    expect(t.audit.events.map((e) => e.action)).toEqual(["recovery.failed"]);
  });
});
