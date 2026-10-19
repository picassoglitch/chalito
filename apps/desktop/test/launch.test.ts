import { describe, expect, it } from "vitest";
import { panelOnLaunch } from "../src/lib/launch.js";

describe("panel at launch", () => {
  it("opens until this computer is signed in and connected", () => {
    expect(panelOnLaunch({ configured: true, connected: false })).toBe(true);
    expect(panelOnLaunch({ configured: false, connected: false })).toBe(true);
  });
  it("stays hidden once connected: only the pet shows", () => {
    expect(panelOnLaunch({ configured: true, connected: true })).toBe(false);
  });
});
