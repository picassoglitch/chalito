import { supabaseEndorseWatch, type BrowserSupabase, type EndorseWatch } from "@chalito/client";
import {
  assertWithServerChallenge,
  deviceLogin,
  httpApi,
  stepUpWithPasskey,
  type ApiClient,
  type StepUpAssertion,
  type DeviceKeys as RawDeviceKeys,
} from "@chalito/client-keys";
import type { PhoneVerifier } from "@chalito/ui";
import { env } from "./env";
import { enrollPasskey, loadDeviceKeys, saveDeviceKeys, trustIntroducedAgents, type DeviceKeys } from "./keys";
import type { IntroducedAgent } from "@chalito/protocol";
import { httpMcp, type McpApi } from "./mcp";
import { apiPhone, type ChannelSetter } from "./phone";
import { supabase } from "./supabase";
import { httpStore, type StoreApi } from "./store";
import { httpUsage, type UsageApi } from "./usage";
import { httpAccount, type AccountApi } from "./account";

/**
 * Everything the app shell needs from the outside world. Production builds it from env (this
 * file); the dev/test mock backend (src/dev) provides its own, so both run the same session logic.
 */
export interface Platform {
  /** The browser's single Supabase client (auth + data + realtime, schema chalito). */
  db: BrowserSupabase;
  url: string;
  publishableKey: string;
  loadDeviceKeys(): Promise<DeviceKeys | null>;
  /** connect()'s device sign-in: a signed refresh challenge → magic-link hash for THIS device's user. */
  deviceLogin(keys: DeviceKeys["keys"], owner: string): () => Promise<string>;
  phone(token: () => Promise<string | null>): { verifier: PhoneVerifier; channels: ChannelSetter };
  mcp(token: () => Promise<string | null>): McpApi;
  enrollPasskey(keys: DeviceKeys["keys"], token: () => Promise<string | null>): Promise<void>;
  assertPasskey(token: () => Promise<string | null>): Promise<Record<string, unknown>>;
  /** GET /v1/usage/daily (orchestrator) as this device. */
  usage(token: () => Promise<string | null>): UsageApi;
  /** /v1/store (catalog, purchase, equip) as whoever is signed in (person or device). */
  store(token: () => Promise<string | null>): StoreApi;
  /** /v1/account/* (deletion and export) as whoever is signed in (person or device). */
  account(token: () => Promise<string | null>): AccountApi;
  /** The api as whoever the bearer is (/v1/endorse: the person on a new browser, the device on a trusted one). */
  api(token: () => Promise<string | null>): ApiClient;
  /** Hears the endorsement pointer on `chalito:pairing:<codeId>` with the code's scoped watch token. */
  endorseWatch: EndorseWatch;
  /** Stores a new identity for this browser (replacing the old one). */
  saveDeviceKeys(keys: RawDeviceKeys): Promise<void>;
  /** This device's passkey as an assertion over a given challenge (R-L13: bound to what it approves). */
  passkeyAssertion(ref: { credentialId: string; rpId: string }): StepUpAssertion;
  /** ADR 0018: stores introduced (vetted) computers in this browser's trust list. */
  trustIntroduced(keys: RawDeviceKeys, agents: IntroducedAgent[], endorsedBy: string): Promise<void>;
}

export const productionPlatform = (): Platform => ({
  db: supabase(),
  url: env.supabaseUrl,
  publishableKey: env.supabaseAnonKey,
  loadDeviceKeys,
  // No bearer: the signature over the challenge is the authentication (/v1/devices/token).
  deviceLogin: (keys, owner) => deviceLogin(httpApi({ baseUrl: env.apiBase, token: async () => null }), keys, owner),
  phone: (token) => apiPhone(env.apiBase, token),
  mcp: (token) => httpMcp(env.apiBase, token),
  enrollPasskey: (keys, token) => enrollPasskey(keys, env.apiBase, token),
  assertPasskey: async (token) =>
    (await assertWithServerChallenge(httpApi({ baseUrl: env.apiBase, token }))) as unknown as Record<string, unknown>,
  api: (token) => httpApi({ baseUrl: env.apiBase, token }),
  usage: (token) => httpUsage(env.orchestratorBase, token),
  store: (token) => httpStore(env.apiBase, token),
  account: (token) => httpAccount(env.apiBase, token),
  endorseWatch: supabaseEndorseWatch(env.supabaseUrl, env.supabaseAnonKey),
  saveDeviceKeys,
  passkeyAssertion: (ref) => stepUpWithPasskey(ref),
  trustIntroduced: trustIntroducedAgents,
});
