import { useEffect, useState } from "react";
import { panelOnLaunch } from "../lib/launch.js";
import { createSession, readEnv, type Connected, type DesktopEnv } from "../lib/session.js";
import type { SignInController } from "../lib/sign-in.js";

/** Where the panel's sign-in stands before the person touches it. */
export type SessionSetup =
  | { state: "starting" }
  | { state: "unconfigured" }
  /** `restoring`: this computer's saved sign-in is still running, so a new sign-in would race it. */
  | { state: "ready"; controller: SignInController; restoring: boolean }
  | { state: "failed"; detail: string };

export interface AccountSessionDeps {
  env: () => DesktopEnv | null;
  start: typeof createSession;
  /** How long the saved sign-in may run before the panel offers a new sign-in anyway. */
  restoreWaitMs: number;
}

const DEFAULT_DEPS: AccountSessionDeps = { env: () => readEnv(), start: createSession, restoreWaitMs: 30_000 };

export const describeError = (e: unknown): string => {
  const o = typeof e === "object" && e !== null ? (e as { name?: unknown; message?: unknown }) : null;
  const message = typeof o?.message === "string" ? o.message.trim().replace(/\.+$/, "") : o ? "" : String(e);
  const name = typeof o?.name === "string" && o.name !== "Error" ? o.name : "";
  return [name, message].filter(Boolean).join(": ") || "unknown error";
};

/** The panel's sign-in controller and account connection; opens the panel at launch until set up. */
export const useAccountSession = (showPanel: () => void, deps: AccountSessionDeps = DEFAULT_DEPS) => {
  const [env] = useState(deps.env);
  const { start, restoreWaitMs } = deps;
  const [conn, setConn] = useState<Connected | null>(null);
  const [setup, setSetup] = useState<SessionSetup>(env ? { state: "starting" } : { state: "unconfigured" });
  useEffect(() => {
    if (!env) {
      if (panelOnLaunch({ configured: false, connected: false })) showPanel();
      return;
    }
    let dispose: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    start(env, (c) => {
      if (alive) setConn(c);
    }).then(
      (s) => {
        if (!alive) return s.dispose();
        dispose = s.dispose;
        setSetup({ state: "ready", controller: s.controller, restoring: s.restoring });
        // A stalled saved sign-in must not leave the person without a panel or a sign-in button;
        // 30 s is well above the 13.5 s first relaunch measured on WebKitGTK.
        const waited = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), restoreWaitMs)));
        void Promise.race([s.restored, waited]).then((connected) => {
          if (!alive) return;
          clearTimeout(timer);
          if (s.restoring) setSetup({ state: "ready", controller: s.controller, restoring: false });
          if (panelOnLaunch({ configured: true, connected })) showPanel();
        });
      },
      (e: unknown) => {
        if (!alive) return;
        // The build is configured, so show what broke, not "isn't configured" (owner, 2026-10-28).
        setSetup({ state: "failed", detail: describeError(e) });
        showPanel();
      },
    );
    return () => {
      alive = false;
      clearTimeout(timer);
      dispose?.();
    };
  }, [env, start, restoreWaitMs, showPanel]);
  return { conn, setup };
};
