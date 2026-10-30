import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopEnv, createSession } from "../src/lib/session.js";
import { SignInController } from "../src/lib/sign-in.js";
import { SsoFlow } from "../src/lib/sso.js";
import { describeError, useAccountSession, type AccountSessionDeps } from "../src/panel/use-account-session.js";

/** A failed session start shows its reason instead of "isn't configured" (owner, 2026-10-28). */

afterEach(cleanup);

const ENV: DesktopEnv = {
  supabaseUrl: "https://example.supabase.co",
  supabaseKey: "sb_publishable_test",
  apiBase: "https://api.example.test",
  ssoStartUrl: "https://www.chalyb.com/app/chalito/auth/desktop",
};

const controller = () =>
  new SignInController({
    flow: new SsoFlow(ENV.ssoStartUrl),
    openUrl: async () => undefined,
    exchange: async () => ({ ok: false, reason: "exchange_failed" }),
    enroll: async () => ({ ok: false, reason: "failed" }),
  });

const run = (start: typeof createSession, env: DesktopEnv | null = ENV, restoreWaitMs = 60_000) => {
  const showPanel = vi.fn();
  const deps: AccountSessionDeps = { env: () => env, start, restoreWaitMs };
  const hook = renderHook(() => useAccountSession(showPanel, deps));
  return { ...hook, showPanel };
};

describe("useAccountSession", () => {
  it("reports the failure and opens the panel when the session can't start", async () => {
    const err = new DOMException("Internal error opening backing store", "UnknownError");
    const { result, showPanel } = run(() => Promise.reject(err));
    expect(result.current.setup).toEqual({ state: "starting" });
    await waitFor(() =>
      expect(result.current.setup).toEqual({
        state: "failed",
        detail: "UnknownError: Internal error opening backing store",
      }),
    );
    expect(showPanel).toHaveBeenCalledTimes(1);
  });

  it("hands over the controller before the saved sign-in finishes, without offering a new sign-in yet", async () => {
    const c = controller();
    let restore: (connected: boolean) => void = () => undefined;
    const restored = new Promise<boolean>((r) => (restore = r));
    const { result, showPanel } = run(async () => ({
      controller: c,
      dispose: () => undefined,
      restoring: true,
      restored,
    }));
    await waitFor(() => expect(result.current.setup).toEqual({ state: "ready", controller: c, restoring: true }));
    expect(showPanel).not.toHaveBeenCalled();
    restore(false);
    await waitFor(() => expect(result.current.setup).toEqual({ state: "ready", controller: c, restoring: false }));
    expect(showPanel).toHaveBeenCalledTimes(1);
  });

  it("offers sign-in and opens the panel when the saved sign-in stalls", async () => {
    const c = controller();
    const { result, showPanel } = run(
      async () => ({
        controller: c,
        dispose: () => undefined,
        restoring: true,
        restored: new Promise(() => undefined),
      }),
      ENV,
      20,
    );
    await waitFor(() => expect(result.current.setup).toEqual({ state: "ready", controller: c, restoring: false }));
    expect(showPanel).toHaveBeenCalledTimes(1);
  });

  it("connects when the saved sign-in lands after the wait", async () => {
    const c = controller();
    let restore: (connected: boolean) => void = () => undefined;
    const { result, showPanel } = run(
      async (_env, onConnected) => ({
        controller: c,
        dispose: () => undefined,
        restoring: true,
        restored: new Promise<boolean>((r) => (restore = r)).then((ok) => (onConnected({} as never), ok)),
      }),
      ENV,
      20,
    );
    await waitFor(() => expect(result.current.setup).toEqual({ state: "ready", controller: c, restoring: false }));
    expect(showPanel).toHaveBeenCalledTimes(1);
    restore(true);
    await waitFor(() => expect(result.current.conn).not.toBeNull());
    expect(showPanel).toHaveBeenCalledTimes(1);
  });

  it("tears down a session that starts after the panel closed, and stays quiet", async () => {
    const dispose = vi.fn();
    let resolve: (s: Awaited<ReturnType<typeof createSession>>) => void = () => undefined;
    const { unmount, showPanel } = run(() => new Promise((r) => (resolve = r)));
    unmount();
    resolve({ controller: controller(), dispose, restoring: false, restored: Promise.resolve(false) });
    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(showPanel).not.toHaveBeenCalled();
  });

  it("doesn't open the panel when the saved sign-in gives up after the panel closed", async () => {
    let restore: (connected: boolean) => void = () => undefined;
    const restored = new Promise<boolean>((r) => (restore = r));
    const { result, unmount, showPanel } = run(async () => ({
      controller: controller(),
      dispose: () => undefined,
      restoring: true,
      restored,
    }));
    await waitFor(() => expect(result.current.setup.state).toBe("ready"));
    unmount();
    restore(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(showPanel).not.toHaveBeenCalled();
  });

  it("stays hidden at launch when the saved sign-in connects", async () => {
    const { result, showPanel } = run(async (_env, onConnected) => {
      onConnected({} as never);
      return { controller: controller(), dispose: () => undefined, restoring: true, restored: Promise.resolve(true) };
    });
    await waitFor(() => expect(result.current.setup.state).toBe("ready"));
    await new Promise((r) => setTimeout(r, 0));
    expect(showPanel).not.toHaveBeenCalled();
    expect(result.current.conn).not.toBeNull();
  });

  it("is unconfigured without the build's account wiring, and never starts a session", () => {
    const start = vi.fn();
    const { result, showPanel } = run(start, null);
    expect(result.current.setup).toEqual({ state: "unconfigured" });
    expect(start).not.toHaveBeenCalled();
    expect(showPanel).toHaveBeenCalledTimes(1);
  });
});

describe("describeError", () => {
  it.each([
    [
      new DOMException("Internal error opening backing store", "UnknownError"),
      "UnknownError: Internal error opening backing store",
    ],
    [new Error("key vault: device id mismatch."), "key vault: device id mismatch"],
    [new Error(""), "unknown error"],
    [{ message: "fetch failed", code: "x" }, "fetch failed"],
    ["boom", "boom"],
  ])("%s → %s", (e, text) => expect(describeError(e)).toBe(text));
});
