"use client";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  DeviceRevokedError,
  connect,
  ensureSession,
  type ChalitoClient,
  sealedMesaState,
  type ClientKeys,
  type MesaApi,
  type MesaDb,
  type MesaStateStore,
  type RevokeAllResult,
  type Snapshot,
} from "@chalito/client";
import type { EndorseTarget } from "@chalito/client-keys";
import type { PhoneVerifier } from "@chalito/ui";
import type { DeviceKeys } from "@/lib/keys";
import {
  approveTarget,
  resolveTarget,
  waitForEndorsement,
  type AddError,
  type DirectoryRow,
  type Resolved,
  type WaitError,
  type Waiting,
} from "@/lib/endorse";
import { markEndorsed, passkeyRef } from "@/lib/keys";
import type { McpApi } from "@/lib/mcp";
import type { AccountApi } from "@/lib/account";
import type { BalanceApi } from "@/lib/balance";
import { disablePush, enablePush, type PushDb, type PushResult } from "@/lib/push";
import { env } from "@/lib/env";
import { readCompanion, type CompanionLook, type StoreApi } from "@/lib/store";
import type { UsageApi } from "@/lib/usage";
import type { ApiClient } from "@chalito/client-keys";
import type { Platform } from "@/lib/platform";
import type { Session, SessionState } from "@/lib/session";
import { SettingsStore, type SettingsDb } from "@/lib/settings-store";

export type ConnStatus = "loading" | "signed_out" | "unpaired" | "revoked" | "error" | "ready";

interface Ctx {
  status: ConnStatus;
  /** The Supabase session this browser holds: the person's (before pairing) or this device's own. */
  session: SessionState;
  client: ChalitoClient | null;
  /** This browser's device id (from its keys), when paired. */
  deviceId: string | null;
  phoneVerifier: PhoneVerifier;
  /** Server-side settings (signed in, paired or not); null when signed out (settings stay on this device). */
  settings: SettingsStore | null;
  /** This device's passkey for HIGH/CRITICAL approvals ("Protege tus aprobaciones con tu passkey"). */
  passkey: PasskeyState;
  /** MCP connectors api (consent, "Apps conectadas", card sharing); null when signed out. */
  mcp: McpApi | null;
  /** A passkey assertion over the server's challenge (/v1/webauthn/assert/options), for consent. */
  assertPasskey: (() => Promise<Record<string, unknown>>) | null;
  /** Whether a session's or device's card is shared with connected apps (chalito.mcp_sharing, RLS read). */
  readSharing: ((scope: "session" | "device", target: string) => Promise<boolean>) | null;
  /**
   * "Esperando aprobación": this browser is signed in as the person but not trusted yet. Opens a
   * code for a trusted device to approve; on success this browser signs in as itself. Null otherwise.
   */
  newDevice: ((name: string) => Promise<Waiting | { error: WaitError }>) | null;
  /** "Añadir un dispositivo": a trusted (ready) browser endorses another one. Null otherwise. */
  addDevice: AddDevice | null;
  /** Token usage (/uso), read as this device; null until paired. */
  usage: UsageApi | null;
  /**
   * Revokes a device on the SERVER (/v1/devices/revoke: its account is disabled and its sessions
   * end), before the signed per-agent commands (review R-H5). Null until paired.
   */
  revokeDevice: ((deviceId: string) => Promise<"ok" | "failed">) | null;
  /**
   * "Cerrar sesión en todos los demás dispositivos": every other client revoked server-side with
   * this device's passkey, plus signed revokes for the computers it trusts. Null until paired.
   */
  revokeAll: (() => Promise<RevokeAllResult | "cancelled" | "no_passkey" | "failed">) | null;
  /** Rooms (/salas, /r/[id]): reads with this device's session, api calls, and its room keys. */
  rooms: {
    db: unknown;
    api: ApiClient;
    keyring: DeviceKeys["roomKeyring"];
    signGlyph: DeviceKeys["signGlyph"];
    identity: DeviceKeys["identity"];
    /** This owner's active client devices (a new room's key is wrapped to each). */
    myClients: () => Promise<{ deviceId: string; pubBox: string }[]>;
  } | null;
  /** Mesa (/m, /m/[id], "Tus claves"): RLS reads as this device, the orchestrator, its keys. Null until paired. */
  mesa: MesaCtx | null;
  /** The store (/tienda) and the companion it dresses; null when signed out. */
  store: StoreApi | null;
  readCompanion: (() => Promise<CompanionLook | null | "error">) | null;
  /** Account deletion and export (/v1/account/*); null when signed out. Requesting needs `client`. */
  account: AccountApi | null;
  /** The hub balance in tokens (/creditos); null when signed out. */
  balance: BalanceApi | null;
  /** Web Push on this browser (its own push_subscriptions row, written as this device). Null until paired. */
  push: { enable: () => Promise<PushResult>; disable: () => Promise<PushResult> } | null;
}

export interface MesaCtx {
  db: MesaDb;
  api: MesaApi;
  keys: ClientKeys;
  owner: string;
  /** This device's goal + card per Mesa, sealed to itself in localStorage. */
  state: MesaStateStore;
}

/** localStorage, or a no-op stand-in where it's blocked (the goal is then asked for again). */
const localStore = (): Pick<Storage, "getItem" | "setItem"> => {
  try {
    const s = window.localStorage;
    s.getItem("chalito.probe");
    return s;
  } catch {
    return { getItem: () => null, setItem: () => undefined };
  }
};

export interface AddDevice {
  resolve(input: { glyph: unknown } | { shortCode: string }): Promise<Resolved>;
  approve(target: EndorseTarget): Promise<{ ok: true } | { ok: false; reason: AddError }>;
}

type SharingDb = {
  from(t: string): {
    select(c: string): {
      eq(
        c: string,
        v: unknown,
      ): { eq(c: string, v: unknown): { maybeSingle(): PromiseLike<{ data: { enabled?: boolean } | null }> } };
    };
  };
};
const sharingReader =
  (db: unknown) =>
  async (scope: "session" | "device", target: string): Promise<boolean> => {
    const { data } = await (db as SharingDb)
      .from("mcp_sharing")
      .select("enabled")
      .eq("scope", scope)
      .eq("target", target)
      .maybeSingle();
    return data?.enabled === true;
  };

/** `replace_refused`: the api wants the CURRENT passkey to replace it (R-M11) and didn't get it. */
export type EnrollResult = "ok" | "cancelled" | "replace_refused" | "error";
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
  session: { status: "loading" },
  client: null,
  deviceId: null,
  phoneVerifier: unavailable,
  settings: null,
  passkey: NO_PASSKEY,
  mcp: null,
  assertPasskey: null,
  readSharing: null,
  newDevice: null,
  addDevice: null,
  usage: null,
  store: null,
  readCompanion: null,
  rooms: null,
  mesa: null,
  revokeDevice: null,
  revokeAll: null,
  push: null,
  account: null,
  balance: null,
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

/** The account (hub user id): the person's own id, or the owner a device session carries. */
export const ownerOf = (s: Session): string => {
  const c = (s.user?.app_metadata as { chalito?: { owner?: unknown } } | undefined)?.chalito;
  return typeof c?.owner === "string" ? c.owner : (s.user?.id ?? "");
};

/** The person's own session (hub SSO), as opposed to a device's (role client). */
const isPersonSession = (s: Session): boolean =>
  (s.user?.app_metadata as { chalito?: { role?: unknown } } | undefined)?.chalito?.role !== "client";

const loadPlatform = async (): Promise<Platform> => {
  // DEV/TEST ONLY (never on Vercel; see next.config.ts): the mock backend. The env read is inlined
  // so webpack sees `if (false)` in normal builds and never emits src/dev.
  if (process.env.NEXT_PUBLIC_CHALITO_DEV_BACKEND === "1") return (await import("@/dev/backend")).startDevBackend();
  return (await import("@/lib/platform")).productionPlatform();
};

/**
 * Connects this browser to its owner's data. Before pairing it uses the person's own session
 * (hub SSO): onboarding, settings, consent viewing. Once this browser holds device keys, it signs
 * in as ITSELF (packages/client ensureSession kind "device", deviceLogin from client-keys): live
 * data, decisions, consent approval and sharing all use that device session. A revoked device
 * lands on the "revoked" state and forgets the agents it trusted.
 */
type DirectoryDb = {
  from(t: string): {
    select(c: string): {
      eq(c: string, v: unknown): PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
    };
  };
};
/** The account's devices directory (RLS), for vetting introduced computers (ADR 0018). */
const readDirectory = async (db: unknown, owner: string): Promise<DirectoryRow[]> => {
  const { data, error } = await (db as DirectoryDb)
    .from("devices")
    .select("device_id, role, revoked, pub_sign, pub_box, name")
    .eq("owner", owner);
  if (error || !data) throw new Error("directory");
  return data.map((r) => ({
    deviceId: String(r.device_id),
    role: r.role === "agent" ? "agent" : "client",
    revoked: r.revoked !== false,
    pubSign: String(r.pub_sign ?? ""),
    pubBox: String(r.pub_box ?? ""),
    name: String(r.name ?? ""),
  }));
};

const newDevice =
  (platform: Platform, owner: string, token: () => Promise<string | null>) =>
  async (name: string): Promise<Waiting | { error: WaitError }> => {
    const w = await waitForEndorsement({
      api: platform.api(token),
      watch: platform.endorseWatch,
      save: (k) => platform.saveDeviceKeys(k),
      owner,
      name,
      // Read with the person's session, before this browser switches to its own.
      directory: () => readDirectory(platform.db, owner),
      trustIntroduced: (k, agents, by) => platform.trustIntroduced(k, agents, by),
    });
    if ("error" in w) return w;
    return {
      ...w,
      // Enrolled: from now on this browser is its own device user, not the person's session. The
      // auth change reruns the connection, which now finds trusted keys.
      result: w.result.then(async (r) => {
        if (!r.ok) return r;
        markEndorsed(r.deviceId);
        try {
          await ensureSession(platform.db.auth as never, {
            kind: "device",
            deviceId: r.deviceId,
            login: async () => r.customToken,
          });
        } catch {
          return { ok: false, reason: "failed" } as const;
        }
        return r;
      }),
    };
  };

const addDevice = (
  platform: Platform,
  keys: DeviceKeys,
  owner: string,
  token: () => Promise<string | null>,
): AddDevice => {
  const api = platform.api(token);
  return {
    resolve: (input) => resolveTarget(api, input, Date.now()),
    approve: (target) => {
      // Required when this device has a passkey: it signs the endorsement body itself (R-L13).
      const ref = passkeyRef();
      return approveTarget(api, keys.keys, target, {
        owner,
        now: Date.now(),
        ...(ref ? { stepUp: platform.passkeyAssertion(ref) } : {}),
        // ADR 0018: the new browser can prompt these computers right away.
        agents: keys.keys.trustedAgents(),
      });
    },
  };
};

export const ChalitoProvider = ({ children }: { children: ReactNode }) => {
  const [ctx, setCtx] = useState<Ctx>(INITIAL);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  /** Once the device sign-in starts, session churn (its own sign-out/sign-in) must not restart it. */
  const deviceMode = useRef(false);
  const clientRef = useRef<ChalitoClient | null>(null);
  const keysRef = useRef<DeviceKeys | null>(null);

  useEffect(() => {
    let alive = true;
    void loadPlatform()
      .then((p) => alive && setPlatform(p))
      .catch(() => alive && setCtx({ ...INITIAL, status: "error" }));
    return () => {
      alive = false;
      void clientRef.current?.close();
    };
  }, []);

  // The browser's Supabase session.
  useEffect(() => {
    if (!platform) return;
    const auth = platform.db.auth as unknown as {
      getSession(): Promise<{ data: { session: Session | null } }>;
      onAuthStateChange(cb: (e: string, s: Session | null) => void): {
        data: { subscription: { unsubscribe(): void } };
      };
    };
    let alive = true;
    void auth.getSession().then(({ data }) => {
      if (alive) setSession(data.session ? { status: "signed_in", session: data.session } : { status: "signed_out" });
    });
    const { data } = auth.onAuthStateChange((_e, s) =>
      setSession(s ? { status: "signed_in", session: s } : { status: "signed_out" }),
    );
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [platform]);

  useEffect(() => setCtx((c) => ({ ...c, session })), [session]);

  useEffect(() => {
    if (!platform || deviceMode.current || session.status === "loading") return;
    let alive = true;
    const done = (c: Omit<Ctx, "session">) => alive && setCtx((prev) => ({ ...c, session: prev.session }));
    void (async () => {
      if (session.status === "signed_out") return done({ ...INITIAL, status: "signed_out" });
      const owner = ownerOf(session.session);
      const token = async () =>
        ((await platform.db.auth.getSession()) as { data: { session: Session | null } }).data.session?.access_token ??
        null;
      const phone = platform.phone(token);
      const settings = new SettingsStore(platform.db as unknown as SettingsDb, owner, phone.channels);
      const base = {
        phoneVerifier: withProposal(phone.verifier, settings),
        settings,
        mcp: platform.mcp(token),
        readSharing: sharingReader(platform.db),
        store: platform.store(token),
        account: platform.account(token),
        balance: platform.balance(token),
        readCompanion: () => readCompanion(platform.db, owner),
      };
      const keys = await platform.loadDeviceKeys();
      if (!keys)
        return done({
          ...INITIAL,
          ...base,
          status: "unpaired",
          newDevice: isPersonSession(session.session) ? newDevice(platform, owner, token) : null,
        });
      keysRef.current = keys;
      deviceMode.current = true;
      try {
        const client = await connect({
          url: platform.url,
          publishableKey: platform.publishableKey,
          keys: keys.keys,
          owner,
          stepUp: keys.stepUp,
          signIn: { kind: "device", deviceId: keys.keys.deviceId, login: platform.deviceLogin(keys.keys, owner) },
          create: () => platform.db,
        });
        clientRef.current = client;
        done({
          ...base,
          status: "ready",
          client,
          deviceId: keys.keys.deviceId,
          passkey: {
            available: true,
            enrolled: passkeyRef() !== null,
            enroll: async () => {
              try {
                await platform.enrollPasskey(keys.keys, token);
              } catch (err) {
                const e = err as { name?: string; code?: string } | null;
                if (e?.name === "NotAllowedError") return "cancelled";
                if (
                  ["current_passkey_required", "current_passkey_failed", "authenticator_cloned"].includes(e?.code ?? "")
                )
                  return "replace_refused";
                return "error";
              }
              setCtx((c) => ({ ...c, passkey: { ...c.passkey, enrolled: true } }));
              return "ok";
            },
          },
          assertPasskey: () => platform.assertPasskey(token),
          newDevice: null,
          addDevice: addDevice(platform, keys, owner, token),
          rooms: {
            db: platform.db,
            api: platform.api(token),
            keyring: keys.roomKeyring,
            signGlyph: keys.signGlyph,
            identity: keys.identity,
            myClients: async () =>
              (await readDirectory(platform.db, owner))
                .filter((d) => d.role === "client" && !d.revoked && d.pubBox)
                .map((d) => ({ deviceId: d.deviceId, pubBox: d.pubBox })),
          },
          usage: platform.usage(token),
          mesa: {
            db: platform.db as unknown as MesaDb,
            api: platform.mesa(token),
            keys: keys.keys,
            owner,
            state: sealedMesaState(keys.keys, localStore()),
          },
          push: {
            enable: () =>
              enablePush({
                vapidKey: env.vapidPublicKey,
                db: platform.db as unknown as PushDb,
                owner,
                deviceId: keys.keys.deviceId,
              }),
            disable: () => disablePush({ db: platform.db as unknown as PushDb, owner, deviceId: keys.keys.deviceId }),
          },
          revokeAll: async () => {
            try {
              return await client.actions.revokeAll({
                api: platform.api(token),
                stepUp: () => platform.assertPasskey(token),
              });
            } catch (err) {
              const e = err as { name?: string; code?: string } | null;
              if (e?.name === "NotAllowedError" || e?.code === "step_up_cancelled") return "cancelled" as const;
              if (e?.code === "passkey_required" || e?.code === "step_up_required") return "no_passkey" as const;
              return "failed" as const;
            }
          },
          revokeDevice: async (deviceId: string) => {
            try {
              await platform.api(token).post("/v1/devices/revoke", { deviceId });
              return "ok" as const;
            } catch {
              return "failed" as const;
            }
          },
        });
      } catch (err) {
        if (err instanceof DeviceRevokedError) {
          await keys.forget().catch(() => undefined);
          return done({ ...INITIAL, ...base, status: "revoked" });
        }
        deviceMode.current = false;
        done({ ...INITIAL, ...base, status: "error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [platform, session]);

  // Revoked while connected (the live store saw this device's row revoked): forget its trust too.
  useEffect(() => {
    const client = ctx.client;
    if (!client) return;
    return client.live.subscribe(() => {
      if (client.live.getSnapshot().status === "revoked") void keysRef.current?.forget().catch(() => undefined);
    });
  }, [ctx.client]);

  return <Chalito.Provider value={ctx}>{children}</Chalito.Provider>;
};

export const useChalito = () => useContext(Chalito);

/** The browser's session (the person's, or this device's once paired). */
export const useSession = (): SessionState => useContext(Chalito).session;

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
