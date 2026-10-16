import { describe, expect, it } from "vitest";
import { Origin, Recipe, RelayedCommand, isSignedOrigin } from "../src/index.js";

/** M16 D (ADR 0022 §4): the a2a: origin, hand-off relays, and the chat-api / a2a recipe kinds. */
const ct = {
  alg: "xchacha20poly1305+sealedbox",
  nonce: "A".repeat(32),
  ct: "Y2lwaGVy",
  keys: { dev_agent: "A".repeat(107) },
};
const body = (origin: string, payload: Record<string, unknown>) => ({
  v: 1,
  cid: "lnk_0123456789",
  uid: "u_1",
  targetDeviceId: "dev_agent",
  origin,
  nonce: "A".repeat(22),
  issuedAt: 1_790_000_000_000,
  expiresAt: 1_790_000_060_000,
  payload,
});
const start = (over: Record<string, unknown> = {}) => ({
  type: "session.start",
  appId: "claude-code",
  workspaceLabel: "chalito",
  promptCt: ct,
  permissionMode: "default",
  ...over,
});

describe("the a2a: origin", () => {
  it("parses, and is never a signed origin", () => {
    expect(Origin.safeParse("a2a:con_abc-123").success).toBe(true);
    expect(Origin.safeParse("a2a:").success).toBe(false);
    expect(Origin.safeParse("a2a:https://x").success).toBe(false);
    expect(isSignedOrigin("a2a:con_abc")).toBe(false);
  });
});

describe("hand-off relays", () => {
  const ok = (relayedBy: string, origin: string, payload: Record<string, unknown>) => {
    return RelayedCommand.safeParse({ relayedBy, body: body(origin, payload) }).success;
  };

  it("the A2A server relays only a2a:* session.start, at most in the default mode", () => {
    expect(ok("a2a-server", "a2a:con_1", start())).toBe(true);
    expect(ok("a2a-server", "a2a:con_1", start({ permissionMode: "plan" }))).toBe(true);
    expect(ok("a2a-server", "a2a:con_1", start({ permissionMode: "acceptEdits" }))).toBe(false);
    expect(ok("a2a-server", "a2a:con_1", start({ codexSandbox: "read-only" }))).toBe(false);
    expect(ok("a2a-server", "a2a:con_1", { type: "session.prompt", sid: "s_1", promptCt: ct })).toBe(false);
    expect(ok("a2a-server", "mcp:claude", start())).toBe(false);
  });

  it("nobody else relays a2a:*; the MCP gateway may relay a hand-off start; the notifier still only prompts", () => {
    expect(ok("mcp-gateway", "a2a:con_1", start())).toBe(false);
    expect(ok("notifier", "a2a:con_1", start())).toBe(false);
    expect(ok("mcp-gateway", "mcp:claude", start())).toBe(true);
    expect(ok("mcp-gateway", "mcp:claude", start({ permissionMode: "acceptEdits" }))).toBe(false);
    expect(ok("notifier", `call:CA${"0".repeat(32)}`, start())).toBe(false);
    expect(ok("notifier", `call:CA${"0".repeat(32)}`, { type: "session.prompt", sid: "s_1", promptCt: ct })).toBe(true);
  });
});

describe("chat-api and a2a recipes", () => {
  const base = {
    v: 1,
    id: "my-model",
    name: "My model",
    vendor: "Me",
    homepage: "https://example.com/",
    termsUrl: "https://example.com/terms",
    platforms: {},
    capabilities: ["sessions"],
  };
  const parse = (r: Record<string, unknown>) => Recipe.safeParse({ ...base, ...r });

  it("a chat-api recipe needs its driver; https anywhere, http only on loopback; an api-key sign-in needs apiKey", () => {
    const signin = { via: "none", planSignin: "off" };
    expect(
      parse({ kinds: ["chat-api"], signin, driver: { chatApi: { baseUrl: "http://localhost:11434/v1" } } }).success,
    ).toBe(true);
    expect(parse({ kinds: ["chat-api"], signin, driver: {} }).success).toBe(false);
    expect(
      parse({ kinds: ["chat-api"], signin, driver: { chatApi: { baseUrl: "http://10.0.0.2:11434/v1" } } }).success,
    ).toBe(false);
    expect(
      parse({ kinds: ["chat-api"], signin, driver: { chatApi: { baseUrl: "https://k:s@api.x.ai/v1" } } }).success,
    ).toBe(false);
    expect(
      parse({
        kinds: ["chat-api"],
        signin: { via: "api-key", planSignin: "off" },
        driver: { chatApi: { baseUrl: "https://api.x.ai/v1" } },
      }).success,
    ).toBe(false);
    expect(
      parse({
        kinds: ["chat-api"],
        signin,
        driver: { chatApi: { baseUrl: "https://api.x.ai/v1", headers: { Authorization: "Bearer x" } } },
      }).success,
    ).toBe(false);
  });

  it("an a2a recipe needs an https URL; notConnectable never sits on an agent driver", () => {
    const signin = { via: "none", planSignin: "off" };
    expect(parse({ kinds: ["a2a"], signin, driver: { a2a: { url: "https://agent.example.com" } } }).success).toBe(true);
    expect(parse({ kinds: ["a2a"], signin, driver: { a2a: { url: "http://agent.example.com" } } }).success).toBe(false);
    expect(
      parse({
        kinds: ["a2a"],
        signin,
        driver: { a2a: { url: "https://agent.example.com" } },
        notConnectable: { reason: "x" },
      }).success,
    ).toBe(false);
  });
});
