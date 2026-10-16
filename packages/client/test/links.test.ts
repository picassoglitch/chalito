import { describe, expect, it } from "vitest";
import { linkEventLine, type EventView } from "../src/index.js";

const ev = (type: string, meta: Record<string, unknown>, content: unknown = null): EventView => ({
  sid: "s1",
  eid: "e1",
  seq: 3,
  t: 1,
  type,
  urgency: "low",
  meta: { deviceId: "dev_b", urgency: "low", ...meta },
  content,
  rev: 1,
});

describe("link events on the phone (ADR 0022 §3)", () => {
  it("a hand-off reads as direction, stage and hop", () => {
    expect(
      linkEventLine(
        ev("link.handoff", {
          linkId: "lnk_abcdefgh",
          taskId: "t1",
          direction: "in",
          stage: "refused",
          hop: 2,
          peerDeviceId: "dev_a",
          reason: "cycle",
        }),
      ),
    ).toEqual({
      kind: "handoff",
      linkId: "lnk_abcdefgh",
      direction: "in",
      stage: "refused",
      hop: 2,
      peerDeviceId: "dev_a",
      reason: "cycle",
    });
  });

  it("shared information keeps its content as data", () => {
    const line = linkEventLine(
      ev(
        "link.shared",
        { linkId: "lnk_abcdefgh", mode: "share", direction: "in", peerDeviceId: "dev_a" },
        { parts: [{ text: "hola" }] },
      ),
    );
    expect(line).toMatchObject({ kind: "shared", mode: "share", content: { parts: [{ text: "hola" }] } });
  });

  it("other events and malformed link events give nothing", () => {
    expect(linkEventLine(ev("session.state", { state: "idle" }))).toBeNull();
    expect(linkEventLine(ev("link.handoff", { linkId: "nope" }))).toBeNull();
  });
});
