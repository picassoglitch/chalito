import { describe, expect, it } from "vitest";
import type { DeviceEvent } from "@chalito/protocol";
import { DEVICE_EVENT_MAX_STRING, sanitizeDeviceEvent } from "../src/redact.js";
import { MemoryStore } from "../src/store.js";

const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const HASH = "0123456789abcdef".repeat(4);

type Rejected = Extract<DeviceEvent, { type: "remote_enable.rejected" }>;
const rejected = (attempted: string): Rejected => ({
  v: 1,
  type: "remote_enable.rejected",
  deviceId: "dev_agent",
  attempted,
  origin: "mcp:claude",
  t: 1,
});

describe("device event redaction", () => {
  it("redacts secrets in attempted and other string fields", () => {
    const e = sanitizeDeviceEvent(rejected(`bypass ${SECRET}`));
    expect(e.attempted).toBe("bypass sk-ant-…");
    expect(e).toMatchObject({ v: 1, type: "remote_enable.rejected", deviceId: "dev_agent", t: 1 });
  });

  it("caps strings at 64 chars after redaction, so a cut can't leave part of a secret", () => {
    // Capping first would keep "sk-ant-api03-ab": too short for the key pattern, so it would leak unredacted.
    const attempted = `bypass ${"x".repeat(42)} ${SECRET}`;
    expect(`${attempted}`.slice(0, 64)).toContain("sk-ant-api");
    const e = sanitizeDeviceEvent(rejected(attempted));
    expect(e.attempted.length).toBeLessThanOrEqual(DEVICE_EVENT_MAX_STRING);
    expect(e.attempted).not.toContain("api03");
    expect(sanitizeDeviceEvent(rejected("d".repeat(500))).attempted).toHaveLength(64);
  });

  it("leaves fixed-format fields (policyHash, deviceId, type, t) verbatim", () => {
    const e: DeviceEvent = { v: 1, type: "policy.changed", deviceId: "dev_agent", policyHash: HASH, t: 5 };
    expect(sanitizeDeviceEvent(e)).toEqual(e);
  });

  it("MemoryStore stores the sanitized event in deviceEvents and the audit trail", async () => {
    const store = new MemoryStore();
    await store.publishDeviceEvent(rejected(`dontAsk ${SECRET}`));
    expect(JSON.stringify(store.deviceEvents)).not.toContain("api03");
    expect(JSON.stringify(store.audits)).not.toContain("api03");
  });
});
