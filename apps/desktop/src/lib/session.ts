import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  connect,
  createBrowserSupabase,
  ensureSession,
  indexedDbStorage,
  type ChalitoClient,
  type StepUpProvider,
} from "@chalito/client";
import { DeviceClientKeys, KeyVault, httpApi, passkeyStepUp } from "@chalito/client-keys";
import { deviceLogin } from "./device-login.js";
import { enrollDesktop, unavailableEndorsement, type EndorsementChannel } from "./enrollment.js";
import { SignInController } from "./sign-in.js";
import { SsoFlow, exchange } from "./sso.js";
import { platformAuthenticatorAvailable } from "./stepup.js";

export interface DesktopEnv {
  supabaseUrl: string;
  supabaseKey: string;
  apiBase: string;
  ssoStartUrl: string;
}

/** Public build-time configuration; null when this build has no account wiring. */
export const readEnv = (e: Record<string, string | undefined> = import.meta.env): DesktopEnv | null => {
  const env = {
    supabaseUrl: e.VITE_SUPABASE_URL ?? "",
    supabaseKey: e.VITE_SUPABASE_PUBLISHABLE_KEY ?? "",
    apiBase: (e.VITE_CHALITO_API_BASE ?? "").replace(/\/+$/, ""),
    ssoStartUrl: e.VITE_SSO_START_URL ?? "",
  };
  return Object.values(env).every(Boolean) ? env : null;
};

/** This device's account binding (public identifiers only). */
interface Stored {
  owner: string;
  passkey: { credentialId: string; rpId: string } | null;
}
const STORED_KEY = "chalito-desktop-account";
const loadStored = (): Stored | null => {
  try {
    const v = JSON.parse(localStorage.getItem(STORED_KEY) ?? "null") as Stored | null;
    return typeof v?.owner === "string" ? v : null;
  } catch {
    return null;
  }
};
const saveStored = (s: Stored) => {
  try {
    localStorage.setItem(STORED_KEY, JSON.stringify(s));
  } catch {
    // Next launch signs in again.
  }
};

export interface Connected {
  client: ChalitoClient;
  /** A passkey is enrolled on this device: HIGH/CRITICAL can be approved here. */
  canStepUp: boolean;
}

/**
 * Builds the panel's sign-in and connection. Every chalito:// URL (launch argument, a link
 * opened while running, forwarded by single-instance) and, in debug builds, the loopback
 * callback go to the same controller.
 */
export const createSession = async (
  env: DesktopEnv,
  onConnected: (c: Connected) => void,
  channel: EndorsementChannel = unavailableEndorsement,
): Promise<{ controller: SignInController; dispose: () => void }> => {
  const storage = indexedDbStorage({ dbName: "chalito-desktop" });
  const sb = createBrowserSupabase(env.supabaseUrl, env.supabaseKey, storage);
  const vault = await KeyVault.open("chalito-desktop-keys");
  const token = async () => (await sb.auth.getSession()).data.session?.access_token ?? null;
  const api = httpApi({ baseUrl: env.apiBase, token });

  const connectAs = async (owner: string, passkey: Stored["passkey"]) => {
    const stored = await vault.load();
    if (!stored) throw new Error("no device keys");
    const keys = await DeviceClientKeys.create(stored, vault);
    const client = await connect({
      url: env.supabaseUrl,
      publishableKey: env.supabaseKey,
      keys,
      owner,
      storage,
      signIn: {
        kind: "device",
        deviceId: keys.deviceId,
        login: deviceLogin(httpApi({ baseUrl: env.apiBase, token: async () => null }), keys, owner),
      },
      stepUp: passkeyStepUp(passkey) as StepUpProvider,
    });
    onConnected({ client, canStepUp: passkey !== null });
  };

  const controller = new SignInController({
    flow: new SsoFlow(env.ssoStartUrl),
    openUrl: (url) => openUrl(url),
    ...(import.meta.env.DEV && isTauri()
      ? {
          devRedirect: async (state: string) =>
            `http://127.0.0.1:${await invoke<number>("sso_loopback", { state })}/auth/sso`,
        }
      : {}),
    exchange: (t) => exchange(t, { apiBase: env.apiBase, fetch: (...a) => fetch(...a), auth: sb.auth }),
    enroll: async (owner, onDisplay, signal) => {
      const r = await enrollDesktop({
        owner,
        name: "Chalito (desktop)",
        keys: vault,
        channel,
        userApi: api,
        deviceApi: async (customToken) => {
          const k = await vault.load();
          // From here on the panel is its own device user, not the person's hub session.
          await ensureSession(sb.auth, { kind: "device", deviceId: k!.deviceId, login: async () => customToken });
          return api;
        },
        signer: (k) => DeviceClientKeys.create(k, vault),
        platformAuthenticator: () => platformAuthenticatorAvailable(),
        onDisplay,
        signal,
      });
      if (r.ok) {
        saveStored({ owner, passkey: r.credential });
        await connectAs(owner, r.credential).catch(() => undefined);
      }
      return r;
    },
  });

  const unlisten: (() => void)[] = [];
  if (isTauri()) {
    const handle = (urls: string[] | null) => {
      for (const u of urls ?? []) void controller.handleUrl(u);
    };
    handle(await getCurrent().catch(() => null));
    unlisten.push(await onOpenUrl(handle));
    if (import.meta.env.DEV) unlisten.push(await listen<string>("chalito://sso-callback", (e) => handle([e.payload])));
  }

  // Already enrolled: sign in as this device straight away.
  const stored = loadStored();
  if (stored && (await vault.load())) await connectAs(stored.owner, stored.passkey).catch(() => undefined);

  return { controller, dispose: () => unlisten.forEach((f) => f()) };
};
