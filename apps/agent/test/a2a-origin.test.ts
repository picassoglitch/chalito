import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  decide,
  originAllowed,
  presetPolicy,
  applyRemoteTighten,
  type Classification,
} from "../src/policy/index.js";

/** ADR 0022 §4: `a2a:*` is a relayed origin. Off by default, never auto-approved. */
const c = (over: Partial<Classification>): Classification => ({
  tier: "LOW",
  category: "other",
  reasons: [],
  hardFloor: false,
  sudo: false,
  workspaceEdit: false,
  noWorkspace: false,
  readOnly: false,
  ...over,
});
const devAll = { on: true, toggles: ["autoApproveHigh", "autoApproveCritical", "allowSudo"] as never[], since: 1 };

describe("the a2a: origin", () => {
  it("is off by default, and on only when the local policy says a2a: true", () => {
    expect(originAllowed(DEFAULT_POLICY.origins, "a2a:con_abc")).toBe(false);
    expect(originAllowed({ ...DEFAULT_POLICY.origins, call: true }, "a2a:con_abc")).toBe(false);
    expect(originAllowed({ ...DEFAULT_POLICY.origins, a2a: true }, "a2a:con_abc")).toBe(true);
  });

  it("is never auto-approved, even with every Developer-mode toggle on", () => {
    const base = {
      origin: "a2a:con_abc" as const,
      originAllowed: true,
      devMode: devAll,
      permissionMode: "acceptEdits" as const,
    };
    expect(decide({ ...base, classification: c({ tier: "HIGH" }) })).toEqual({ action: "ask", stepUp: true });
    expect(decide({ ...base, classification: c({ tier: "CRITICAL" }) })).toEqual({
      action: "deny",
      reason: "policy_block",
    });
    // No LOW auto-allow and no accept_edits for an unsigned turn: only reads run on their own.
    expect(decide({ ...base, classification: c({ tier: "LOW" }) })).toEqual({ action: "ask", stepUp: false });
    expect(decide({ ...base, classification: c({ tier: "MED", workspaceEdit: true }) })).toEqual({
      action: "ask",
      stepUp: false,
    });
    expect(decide({ ...base, classification: c({ tier: "LOW", readOnly: true }) })).toMatchObject({ action: "allow" });
    expect(decide({ ...base, originAllowed: false, classification: c({ readOnly: true }) })).toEqual({
      action: "deny",
      reason: "origin_disabled",
    });
  });

  it("no remote tighten or preset turns it on; Estricto turns it off", () => {
    const on = { ...DEFAULT_POLICY, origins: { ...DEFAULT_POLICY.origins, a2a: true } };
    expect(presetPolicy("estricto", on).origins.a2a).toBe(false);
    for (const p of ["estandar", "relajado"] as const)
      expect(presetPolicy(p, DEFAULT_POLICY).origins.a2a).toBeUndefined();
    expect(applyRemoteTighten(DEFAULT_POLICY, { origins: { ...DEFAULT_POLICY.origins, a2a: true } })).toMatchObject({
      ok: false,
    });
  });
});
