import { describe, expect, it } from "vitest";
import {
  ALLOW_EVERYTHING_WARNING,
  allowEverythingOn,
  disableAllowEverything,
  enableAllowEverything,
} from "../src/allow-everything.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy/schema.js";
import { applyRemoteTighten, isTighterOrEqual } from "../src/policy/tighten.js";
import { DEVMODE_OFF, decide } from "../src/policy/decide.js";
import type { Classification } from "../src/policy/classify.js";

const holder = (start: Policy = DEFAULT_POLICY) => {
  let p = start;
  return { get: () => p, set: async (n: Policy) => void (p = n) };
};
const OFF: Policy = { ...DEFAULT_POLICY, allowEverything: { enabled: false } };

describe("allow everything switch (owner 2026-11-02)", () => {
  it("is on unless the policy says enabled: false", () => {
    expect(allowEverythingOn(DEFAULT_POLICY)).toBe(true);
    expect(allowEverythingOn({ allowEverything: { enabled: true } })).toBe(true);
    expect(allowEverythingOn(OFF)).toBe(false);
  });

  it("turns back on only after OS auth and a yes to the warning", async () => {
    for (const [os, yes, reason] of [
      [false, true, "os_auth_failed"],
      [true, false, "cancelled"],
    ] as const) {
      const policy = holder(OFF);
      const r = await enableAllowEverything({
        policy,
        osAuth: { verify: async () => os },
        prompter: { confirm: async () => yes },
        locale: "en",
        emit: () => undefined,
      });
      expect(r).toEqual({ ok: false, reason });
      expect(allowEverythingOn(policy.get())).toBe(false);
    }
    const policy = holder(OFF);
    const shown: string[] = [];
    const events: string[] = [];
    expect(
      await enableAllowEverything({
        policy,
        osAuth: { verify: async () => true },
        prompter: { confirm: async (w) => (shown.push(w), true) },
        locale: "en",
        emit: (t) => void events.push(t),
      }),
    ).toEqual({ ok: true });
    expect(shown).toEqual([ALLOW_EVERYTHING_WARNING.en]);
    expect(events).toEqual(["allow_everything.enabled"]);
    expect(policy.get().allowEverything).toEqual({ enabled: true });
  });

  it("turns off with no prompt, from the default too", async () => {
    const policy = holder();
    expect(await disableAllowEverything({ policy, emit: () => undefined }, "panel")).toBe(true);
    expect(policy.get().allowEverything).toEqual({ enabled: false });
    expect(await disableAllowEverything({ policy, emit: () => undefined }, "panel")).toBe(false);
  });

  it("remote and edits may only turn it off", () => {
    const fs = { home: "/home/x", realpath: (p: string) => p };
    expect(isTighterOrEqual(OFF, DEFAULT_POLICY, fs)).toBe(true);
    expect(isTighterOrEqual(DEFAULT_POLICY, OFF, fs)).toBe(false);
    expect(isTighterOrEqual({ ...OFF, allowEverything: { enabled: true } }, OFF, fs)).toBe(false);
    expect(applyRemoteTighten(DEFAULT_POLICY, { allowEverything: { enabled: false } }, fs)).toMatchObject({ ok: true });
    expect(applyRemoteTighten(OFF, { allowEverything: { enabled: true } }, fs)).toEqual({
      ok: false,
      reason: "would_loosen",
    });
  });

  it("decide allows every tier, the hard floor, no workspace, a disabled origin and plan mode", () => {
    const c: Classification = {
      tier: "CRITICAL",
      category: "other",
      reasons: [],
      hardFloor: true,
      sudo: true,
      workspaceEdit: false,
      noWorkspace: true,
      readOnly: false,
      fenced: true,
    };
    const input = {
      classification: c,
      origin: "mcp:x" as const,
      originAllowed: false,
      devMode: DEVMODE_OFF,
      permissionMode: "plan" as const,
    };
    expect(decide({ ...input, allowEverything: true })).toEqual({ action: "allow", via: "allow_everything" });
    expect(decide(input)).toEqual({ action: "deny", reason: "no_workspace" });
  });
});
