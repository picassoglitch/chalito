import { supabaseEndorseWatch, type BrowserSupabase, type EndorseWatch } from "@chalito/client";
import {
  assertWithServerChallenge,
  deviceLogin,
  httpApi,
  type ApiClient,
  type DeviceKeys as RawDeviceKeys,
} from "@chalito/client-keys";
import type { PhoneVerifier } from "@chalito/ui";
import { env } from "./env";
import { enrollPasskey, loadDeviceKeys, saveDeviceKeys, type DeviceKeys } from "./keys";
import { httpMcp, type McpApi } from "./mcp";
import { apiPhone, type ChannelSetter } from "./phone";
import { supabase } from "./supabase";

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
  /** The api as whoever the bearer is (/v1/endorse: the person on a new browser, the device on a trusted one). */
  api(token: () => Promise<string | null>): ApiClient;
  /** Hears the endorsement pointer on `chalito:pairing:<codeId>` with the code's scoped watch token. */
  endorseWatch: EndorseWatch;
  /** Stores a new identity for this browser (replacing the old one). */
  saveDeviceKeys(keys: RawDeviceKeys): Promise<void>;
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
  endorseWatch: supabaseEndorseWatch(env.supabaseUrl, env.supabaseAnonKey),
  saveDeviceKeys,
});
