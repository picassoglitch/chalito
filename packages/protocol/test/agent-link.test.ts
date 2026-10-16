import { describe, expect, it } from "vitest";
import {
  AgentLink,
  CommandPayload,
  LINK_MAX_HOPS,
  LinkCreateSpec,
  Origin,
  denyAllLinkAuthorizer,
  isAgentOrigin,
  isSignedOrigin,
} from "../src/index.js";

const KEY = "a".repeat(43);
const now = Date.now();
const link = (o: Record<string, unknown> = {}) => ({
  v: 1,
  id: "lnk_abcdefgh",
  mode: "handoff",
  sender: { deviceId: "dev_a" },
  receiver: { deviceId: "dev_a", appId: "claude-code" },
  workspaceLabel: "chalito",
  goal: "Probar el login",
  expiresAt: now + 60_000,
  dailyTokenBudget: 1000,
  ratePerHour: 5,
  createdAt: now,
  createdBy: "local",
  ...o,
});

describe("agent links (ADR 0022 §3)", () => {
  it("agent:<sid> is an origin, relayed and never signed", () => {
    expect(Origin.safeParse("agent:sess_1").success).toBe(true);
    expect(Origin.safeParse("agent:").success).toBe(false);
    expect(isSignedOrigin("agent:sess_1")).toBe(false);
    expect(isAgentOrigin("agent:sess_1")).toBe(true);
    expect(isAgentOrigin("client:x")).toBe(false);
  });

  it("defaults: ask me each time, ceiling default", () => {
    expect(AgentLink.parse(link())).toMatchObject({ confirm: true, permissionCeiling: "default" });
  });

  it("a hand-off link is made only locally; a client may make share links", () => {
    expect(AgentLink.safeParse(link({ createdBy: "client:dev_phone" })).success).toBe(false);
    expect(AgentLink.safeParse(link({ mode: "share", createdBy: "client:dev_phone" })).success).toBe(true);
    expect(AgentLink.safeParse(link({ mode: "share", createdBy: "mcp:claude" })).success).toBe(false);
    const { v: _v, createdAt: _c, createdBy: _b, ...spec } = link();
    expect(LinkCreateSpec.safeParse(spec).success).toBe(false);
    expect(LinkCreateSpec.safeParse({ ...spec, mode: "share" }).success).toBe(true);
    expect(CommandPayload.safeParse({ type: "link.create", link: spec }).success).toBe(false);
  });

  it("limits: at most 30 days, cross-device links record both ends' keys, no self-link", () => {
    expect(AgentLink.safeParse(link({ expiresAt: now + 31 * 86_400_000 })).success).toBe(false);
    expect(AgentLink.safeParse(link({ receiver: { deviceId: "dev_b" } })).success).toBe(false);
    expect(
      AgentLink.safeParse(
        link({
          sender: { deviceId: "dev_a", pubSign: KEY, pubBox: KEY },
          receiver: { deviceId: "dev_b", pubSign: KEY, pubBox: KEY },
        }),
      ).success,
    ).toBe(true);
    expect(
      AgentLink.safeParse(
        link({ sender: { deviceId: "dev_a", sessionId: "s1" }, receiver: { deviceId: "dev_a", sessionId: "s1" } }),
      ).success,
    ).toBe(false);
    expect(LINK_MAX_HOPS).toBe(2);
  });

  it("the default authorizer refuses everything", async () => {
    expect(
      await denyAllLinkAuthorizer.authorize({
        origin: "agent:s",
        fromAgent: "a",
        toAgent: "b",
        targetDeviceId: "d",
        hop: 1,
        chain: ["s"],
      }),
    ).toEqual({ ok: false, reason: "no_link" });
  });
});
