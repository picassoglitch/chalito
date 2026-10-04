"use client";
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { connect, type ChalitoClient, type Snapshot } from "@chalito/client";
import type { PhoneVerifier } from "@chalito/ui";
import { env } from "@/lib/env";
import { enrollPasskey, loadDeviceKeys, passkeyRef } from "@/lib/keys";
import { apiPhone } from "@/lib/phone";
import { SettingsStore, type SettingsDb } from "@/lib/settings-store";
import { useSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";

export type ConnStatus = "loading" | "signed_out" | "unpaired" | "error" | "ready";

interface Ctx {
  status: ConnStatus;
  client: ChalitoClient | null;
  /** This browser's device id (from its keys), when paired. */
  deviceId: string | null;
  phoneVerifier: PhoneVerifier;
  /** Server-side settings (signed in, paired or not); null when signed out (settings stay on this device). */
  settings: SettingsStore | null;
  /** This device's passkey for HIGH/CRITICAL approvals ("Protege tus aprobaciones con tu passkey"). */
  passkey: PasskeyState;
}

export type EnrollResult = "ok" | "cancelled" | "error";
export interface PasskeyState {
  /** A paired device can enrol one. */
  available: boolean;
  enrolled: boolean;
  enroll: () => Promise<EnrollResult>;
}
const NO_PASSKEY: PasskeyState = { available: false, enrolled: false, enroll: async () => "error" };

const unavailable: PhoneVerifier = {
  start: async () => ({ ok: false, reason: "error" }),
  check: async () => ({ ok: false, reason: "error" }),
};
const INITIAL: Ctx = {
  status: "loading",
  client: null,
  deviceId: null,
  phoneVerifier: unavailable,
  settings: null,
  passkey: NO_PASSKEY,
};
const Chalito = createContext<Ctx>(INITIAL);

/** Proposes the number (phone_pending_e164) before the api sends the code. */
const withProposal = (v: PhoneVerifier, settings: SettingsStore): PhoneVerifier => ({
  start: async (e164, opts) => {
    try {
      await settings.proposePhone(e164);
    } catch {
      return { ok: false, reason: "invalid" };
    }
    return v.start(e164, opts);
  },
  check: (e164, code) => v.check(e164, code),
});

/**
 * Connects this browser device to its owner's live data (packages/client `connect()`): signed
 * in (hub SSO session) + this device's keys (packages/client-keys). Without keys, the screens
 * ask to pair the device instead of showing data.
 */
export const ChalitoProvider = ({ children }: { children: ReactNode }) => {
  const session = useSession();
  const [ctx, setCtx] = useState<Ctx>(INITIAL);
  const passkeyState = (enroll: () => Promise<void>): PasskeyState => ({
    available: true,
    enrolled: passkeyRef() !== null,
    enroll: async () => {
      try {
        await enroll();
      } catch (err) {
        return (err as { name?: string } | null)?.name === "NotAllowedError" ? "cancelled" : "error";
      }
      setCtx((c) => ({ ...c, passkey: { ...c.passkey, enrolled: true } }));
      return "ok";
    },
  });

  useEffect(() => {
    let alive = true;
    let client: ChalitoClient | null = null;
    const done = (c: Ctx) => alive && setCtx(c);
    void (async () => {
      // DEV/TEST ONLY (never on Vercel; see next.config.ts): mock backend and stub keys. The env
      // read is inlined (not DEV_BACKEND) so webpack sees `if (false)` and never emits src/dev.
      if (process.env.NEXT_PUBLIC_CHALITO_DEV_BACKEND === "1") {
        const dev = await import("@/dev/backend");
        const b = await dev.startDevBackend();
        client = await connect(b.connectOptions);
        const settings = new SettingsStore(b.settingsDb, b.controls.owner, b.channels);
        return done({
          status: "ready",
          client,
          deviceId: b.connectOptions.keys.deviceId,
          phoneVerifier: withProposal(b.phoneVerifier, settings),
          settings,
          passkey: passkeyState(b.enrollPasskey),
        });
      }
      if (session.status === "loading") return;
      if (session.status === "signed_out") return done({ ...INITIAL, status: "signed_out" });
      const owner = session.session.user?.id ?? "";
      const phone = apiPhone(env.apiBase, async () => {
        const { data } = await supabase().auth.getSession();
        return data.session?.access_token ?? null;
      });
      const settings = new SettingsStore(supabase() as unknown as SettingsDb, owner, phone.channels);
      const verifier = withProposal(phone.verifier, settings);
      const keys = await loadDeviceKeys();
      if (!keys) return done({ ...INITIAL, status: "unpaired", phoneVerifier: verifier, settings });
      try {
        client = await connect({
          url: env.supabaseUrl,
          publishableKey: env.supabaseAnonKey,
          keys: keys.keys,
          owner,
          stepUp: keys.stepUp,
          signIn: {
            kind: "sso",
            exchange: async () => {
              throw new Error("signed out");
            },
          },
        });
        const token = async () => (await supabase().auth.getSession()).data.session?.access_token ?? null;
        done({
          status: "ready",
          client,
          deviceId: keys.keys.deviceId,
          phoneVerifier: verifier,
          settings,
          passkey: passkeyState(() => enrollPasskey(keys.keys, env.apiBase, token)),
        });
      } catch {
        done({ ...INITIAL, status: "error", phoneVerifier: verifier, settings });
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
