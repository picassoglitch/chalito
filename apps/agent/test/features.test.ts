import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteScreenOn, remoteTerminalOn } from "../src/features.js";

afterEach(() => vi.unstubAllGlobals());

describe("remote feature build flags", () => {
  const ON = { CHALITO_REMOTE_SCREEN: "1", CHALITO_REMOTE_TERMINAL: "1" };

  it("dev and test builds: off by default, on only with the exact env value", () => {
    expect([remoteScreenOn({}), remoteTerminalOn({})]).toEqual([false, false]);
    expect([
      remoteScreenOn({ CHALITO_REMOTE_SCREEN: "true" }),
      remoteTerminalOn({ CHALITO_REMOTE_TERMINAL: "0" }),
    ]).toEqual([false, false]);
    expect([remoteScreenOn(ON), remoteTerminalOn(ON)]).toEqual([true, true]);
  });

  it("release builds ignore the environment, whatever the user sets", () => {
    vi.stubGlobal("__CHALITO_RELEASE__", true);
    vi.stubGlobal("__CHALITO_REMOTE_SCREEN__", false);
    vi.stubGlobal("__CHALITO_REMOTE_TERMINAL__", false);
    expect([remoteScreenOn(ON), remoteTerminalOn(ON)]).toEqual([false, false]);
    // Not even defined by the build: still off.
    vi.unstubAllGlobals();
    vi.stubGlobal("__CHALITO_RELEASE__", true);
    expect([remoteScreenOn(ON), remoteTerminalOn(ON)]).toEqual([false, false]);
  });

  it("release builds honor only what was baked at build time", () => {
    vi.stubGlobal("__CHALITO_RELEASE__", true);
    vi.stubGlobal("__CHALITO_REMOTE_SCREEN__", true);
    vi.stubGlobal("__CHALITO_REMOTE_TERMINAL__", false);
    expect([remoteScreenOn({}), remoteTerminalOn(ON)]).toEqual([true, false]);
  });
});
