import { describe, expect, it } from "vitest";
import { LanFrame, LanGrant, LanHello, SigningContext } from "../src/index.js";

const b64 = (n: number) => "A".repeat(Math.ceil((n * 4) / 3));
const body = {
  v: 1,
  cid: "c1",
  uid: "u1",
  targetDeviceId: "dev_b",
  origin: "mcp:claude",
  nonce: b64(16),
  issuedAt: 1,
  expiresAt: 2,
  payload: { type: "session.interrupt", sid: "s1" },
};

describe("LAN wire shapes", () => {
  it("has its own signing context", () => {
    expect(SigningContext.options).toContain("chalito.lan-handshake.v1");
  });

  it("a cmd frame carries only a client-signed command, never a relayed one", () => {
    expect(LanFrame.safeParse({ k: "cmd", id: "c1", env: { relayedBy: "mcp-gateway", body } }).success).toBe(false);
    const signed = {
      ctx: "chalito.command.v1",
      body: { ...body, origin: "client:dev_p" },
      signerDeviceId: "dev_p",
      sig: b64(64),
    };
    expect(LanFrame.safeParse({ k: "cmd", id: "c1", env: signed }).success).toBe(true);
    expect(LanFrame.safeParse({ k: "cmd", id: "c1", env: { ...signed, ctx: "chalito.decision.v1" } }).success).toBe(
      false,
    );
  });

  it("the clear-text hello carries no identity", () => {
    const hello = { v: 1, t: "hello", tid: b64(16), e: b64(32), n: b64(32) };
    expect(LanHello.safeParse(hello).success).toBe(true);
    expect(Object.keys(LanHello.parse({ ...hello, deviceId: "dev_a" }))).not.toContain("deviceId");
  });

  it("a grant needs at least one token and bounded lists", () => {
    expect(LanGrant.safeParse({ tokens: [], peers: [] }).success).toBe(false);
    const t = { tid: b64(16), secret: b64(32), expiresAt: 1 };
    expect(LanGrant.safeParse({ tokens: [t, t, t, t, t], peers: [] }).success).toBe(false);
  });
});
