"use client";
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { connect, type ChalitoClient, type Snapshot } from "@chalito/client";
import type { PhoneVerifier } from "@chalito/ui";
import { DEV_BACKEND, env } from "@/lib/env";
import { loadDeviceKeys } from "@/lib/keys";
import { apiPhoneVerifier } from "@/lib/phone";
import { useSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";

export type ConnStatus = "loading" | "signed_out" | "unpaired" | "error" | "ready";

interface Ctx {
  status: ConnStatus;
  client: ChalitoClient | null;
  /** This browser's device id (from its keys), when paired. */
  deviceId: string | null;
  phoneVerifier: PhoneVerifier;
}

const unavailable: PhoneVerifier = {
  start: async () => ({ ok: false, reason: "error" }),
  check: async () => ({ ok: false, reason: "error" }),
};
const Chalito = createContext<Ctx>({ status: "loading", client: null, deviceId: null, phoneVerifier: unavailable });

/**
 * Connects this browser device to its owner's live data (packages/client `connect()`): signed
 * in (hub SSO session) + this device's keys (packages/client-keys). Without keys, the screens
 * ask to pair the device instead of showing data.
 */
export const ChalitoProvider = ({ children }: { children: ReactNode }) => {
  const session = useSession();
  const [ctx, setCtx] = useState<Ctx>({ status: "loading", client: null, deviceId: null, phoneVerifier: unavailable });

  useEffect(() => {
    let alive = true;
    let client: ChalitoClient | null = null;
    const done = (c: Ctx) => alive && setCtx(c);
    void (async () => {
      if (DEV_BACKEND) {
        // DEV/TEST ONLY (never on Vercel; see next.config.ts): mock backend and stub keys.
        const dev = await import("@/dev/backend");
        const b = await dev.startDevBackend();
        client = await connect(b.connectOptions);
        return done({
          status: "ready",
          client,
          deviceId: b.connectOptions.keys.deviceId,
          phoneVerifier: b.phoneVerifier,
        });
      }
      if (session.status === "loading") return;
      if (session.status === "signed_out")
        return done({ status: "signed_out", client: null, deviceId: null, phoneVerifier: unavailable });
      const verifier = apiPhoneVerifier(env.apiBase, async () => {
        const { data } = await supabase().auth.getSession();
        return data.session?.access_token ?? null;
      });
      const keys = await loadDeviceKeys();
      if (!keys) return done({ status: "unpaired", client: null, deviceId: null, phoneVerifier: verifier });
      try {
        client = await connect({
          url: env.supabaseUrl,
          publishableKey: env.supabaseAnonKey,
          keys: keys.keys,
          owner: session.session.user?.id ?? "",
          stepUp: keys.stepUp,
          signIn: {
            kind: "sso",
            exchange: async () => {
              throw new Error("signed out");
            },
          },
        });
        done({ status: "ready", client, deviceId: keys.keys.deviceId, phoneVerifier: verifier });
      } catch {
        done({ status: "error", client: null, deviceId: null, phoneVerifier: verifier });
      }
    })();
    return () => {
      alive = false;
      void client?.close();
    };
  }, [session.status]);

  return <Chalito.Provider value={ctx}>{children}</Chalito.Provider>;
};

export const useChalito = () => useContext(Chalito);

const EMPTY_SNAPSHOT: Snapshot = {
  status: "idle",
  approvals: [],
  sessions: [],
  events: {},
  notifications: [],
  devices: [],
  devModeActive: false,
};
const noop = () => () => undefined;

/** The live snapshot (useSyncExternalStore over packages/client's LiveStore). */
export const useLive = (): Snapshot => {
  const { client } = useChalito();
  return useSyncExternalStore(
    client?.live.subscribe ?? noop,
    client?.live.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    () => EMPTY_SNAPSHOT,
  );
};

/** Re-renders every `ms` (countdowns). */
export const useNow = (ms = 1000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
};
