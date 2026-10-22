import { describe, expect, it } from "vitest";
import type { RouteRules } from "@chalito/protocol";
import type { DeviceView } from "../src/live.js";
import { RoutingError, loadRouteRules, pickComputer, routeComputers, saveRouteRules } from "../src/routing.js";

// The settings RPCs as migration 20261004001100 behaves (prefs merged shallowly, 4 KB cap); the real
// RPCs are exercised by supabase/tests/database/50_route_rules_prefs.test.sql.
const fakeDb = () => {
  let prefs: Record<string, unknown> = { onboarded_at: "2026-10-21" };
  const calls: unknown[] = [];
  return {
    calls,
    prefs: () => prefs,
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      calls.push([fn, args]);
      if (fn === "get_my_settings") return { data: { prefs }, error: null };
      const patch = (args?.p as { prefs?: Record<string, unknown> }).prefs ?? {};
      const next = { ...prefs, ...patch };
      if (JSON.stringify(next).length > 4096) return { data: null, error: { message: "too big", code: "23514" } };
      prefs = next;
      return { data: {}, error: null };
    },
  };
};

const computer = (deviceId: string, o: Partial<DeviceView> = {}): DeviceView => ({
  deviceId,
  role: "agent",
  kind: "desktop",
  platform: "linux",
  name: deviceId,
  revoked: false,
  online: true,
  lastSeenAt: 1,
  devMode: { on: false, toggles: [], since: null },
  policyHash: null,
  lastEvent: null,
  setup: { adapters: ["claude-code", "codex"], workspaces: 1, labels: ["chalito"] },
  rev: 1,
  ...o,
});

const RULES: RouteRules = {
  v: 1,
  rules: [{ workspaceLabel: "chalito", appId: "codex", devices: ["home"] }],
  fallback: ["office"],
};

describe("routing rules in the owner's settings (ADR 0031 §5)", () => {
  it("saves and loads them next to other prefs", async () => {
    const db = fakeDb();
    expect(await loadRouteRules(db)).toBeNull();
    await saveRouteRules(db, RULES);
    expect(db.calls.at(-1)).toEqual(["update_my_settings", { p: { prefs: { routing: RULES } } }]);
    expect(await loadRouteRules(db)).toEqual(RULES);
    expect(db.prefs().onboarded_at).toBe("2026-10-21");
    await saveRouteRules(db, null);
    expect(await loadRouteRules(db)).toBeNull();
  });

  it("refuses a bad shape before sending, and ignores one it doesn't understand when loading", async () => {
    const db = fakeDb();
    await expect(
      saveRouteRules(db, { v: 1, rules: [{ devices: [] }], fallback: [] } as unknown as RouteRules),
    ).rejects.toEqual(new RoutingError("invalid"));
    expect(db.calls).toHaveLength(0);
    await db.rpc("update_my_settings", { p: { prefs: { routing: { v: 2, anything: true } } } });
    expect(await loadRouteRules(db)).toBeNull();
  });

  it("maps a server refusal", async () => {
    const db = {
      rpc: async () => ({ data: null, error: { message: "nope", code: "42501" } }),
    };
    await expect(saveRouteRules(db, RULES)).rejects.toEqual(new RoutingError("failed"));
    await expect(loadRouteRules(db)).rejects.toEqual(new RoutingError("failed"));
  });
});

describe("pickComputer", () => {
  it("uses only the owner's live computers, with what they reported", () => {
    const list = [
      computer("home"),
      computer("phone", { role: "client" }),
      computer("old", { revoked: true }),
      computer("bare", { setup: null }),
    ];
    expect(routeComputers(list).map((c) => c.deviceId)).toEqual(["home", "bare"]);
    expect(routeComputers(list)[1]).toEqual({
      deviceId: "bare",
      online: true,
      adapters: [],
      labels: [],
      workspaces: 0,
    });
  });

  it("follows the rules, falls back when the rule's computer is offline, and says when none can", () => {
    expect(pickComputer(RULES, { workspaceLabel: "chalito" }, [computer("home"), computer("office")])).toMatchObject({
      ok: true,
      deviceId: "home",
      appId: "codex",
      via: "rule",
    });
    expect(
      pickComputer(RULES, { workspaceLabel: "chalito" }, [computer("home", { online: false }), computer("office")]),
    ).toMatchObject({ ok: true, deviceId: "office", via: "fallback" });
    expect(pickComputer(RULES, { workspaceLabel: "chalito" }, [computer("home", { online: false })])).toEqual({
      ok: false,
      reason: "no_computer",
    });
  });
});
