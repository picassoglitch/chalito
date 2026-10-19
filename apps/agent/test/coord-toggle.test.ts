import { DEFAULT_AUTO_KINDS } from "@chalito/protocol";
import { describe, expect, it } from "vitest";
import { coordinatorCeiling, disableCoordinator, enableCoordinator } from "../src/coord/toggle.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy/schema.js";
import { applyRemoteTighten, isTighterOrEqual } from "../src/policy/tighten.js";

const holder = (start: Policy = DEFAULT_POLICY) => {
  let p = start;
  return { get: () => p, set: async (n: Policy) => void (p = n) };
};

describe("coordinator mode on this computer (ADR 0025 §6)", () => {
  it("turns on only after OS auth and the owner's confirmation, with every kind", async () => {
    const policy = holder();
    const events: string[] = [];
    const shown: string[][] = [];
    const res = await enableCoordinator({
      policy,
      osAuth: { verify: async () => true },
      prompter: { confirm: async (a, b) => (shown.push(a, b), true) },
      locale: "es",
      emit: (t) => void events.push(t),
    });
    expect(res).toEqual({ ok: true });
    expect(policy.get().coordinator).toEqual({ enabled: true, autoApprove: [...DEFAULT_AUTO_KINDS] });
    expect(shown[1]).toContain("Subir a main o a cualquier otra rama");
    expect(events).toEqual(["coordinator.enabled"]);
  });

  it("changes nothing when OS auth fails or the owner says no", async () => {
    for (const [os, yes, reason] of [
      [false, true, "os_auth_failed"],
      [true, false, "cancelled"],
    ] as const) {
      const policy = holder();
      const res = await enableCoordinator({
        policy,
        osAuth: { verify: async () => os },
        prompter: { confirm: async () => yes },
        locale: "en",
        emit: () => undefined,
      });
      expect(res).toEqual({ ok: false, reason });
      expect(policy.get().coordinator).toBeUndefined();
    }
  });

  it("turns off with no prompt", async () => {
    const policy = holder({ ...DEFAULT_POLICY, coordinator: { enabled: true } });
    expect(await disableCoordinator({ policy, emit: () => undefined }, "cli")).toBe(true);
    expect(policy.get().coordinator?.enabled).toBe(false);
    expect(await disableCoordinator({ policy, emit: () => undefined }, "cli")).toBe(false);
  });

  it("the ceiling is empty when off and every kind when on without a list", () => {
    expect(coordinatorCeiling(DEFAULT_POLICY)).toEqual([]);
    expect(coordinatorCeiling({ ...DEFAULT_POLICY, coordinator: { enabled: false, autoApprove: ["read"] } })).toEqual(
      [],
    );
    expect(coordinatorCeiling({ ...DEFAULT_POLICY, coordinator: { enabled: true } })).toEqual(DEFAULT_AUTO_KINDS);
    expect(coordinatorCeiling({ ...DEFAULT_POLICY, coordinator: { enabled: true, autoApprove: ["read"] } })).toEqual([
      "read",
    ]);
  });
});

describe("remote surfaces can only tighten coordinator mode", () => {
  const on: Policy = { ...DEFAULT_POLICY, coordinator: { enabled: true, autoApprove: ["read", "tests"] } };

  it("can turn it off or drop kinds", () => {
    expect(applyRemoteTighten(on, { coordinator: { enabled: false } }).ok).toBe(true);
    expect(applyRemoteTighten(on, { coordinator: { autoApprove: ["read"] } }).ok).toBe(true);
  });

  it("can't turn it on or add kinds", () => {
    expect(applyRemoteTighten(DEFAULT_POLICY, { coordinator: { enabled: true } })).toEqual({
      ok: false,
      reason: "would_loosen",
    });
    expect(applyRemoteTighten(on, { coordinator: { autoApprove: ["read", "tests", "git_local"] } })).toEqual({
      ok: false,
      reason: "would_loosen",
    });
    // Dropping the list means "every kind": a loosening.
    expect(isTighterOrEqual({ ...on, coordinator: { enabled: true } }, on)).toBe(false);
  });

  it("an unknown kind is an invalid patch", () => {
    expect(applyRemoteTighten(on, { coordinator: { autoApprove: ["everything"] } })).toEqual({
      ok: false,
      reason: "invalid_patch",
    });
  });
});
