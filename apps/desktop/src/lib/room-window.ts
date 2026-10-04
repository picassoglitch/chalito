import {
  createBorrowedSupabase,
  indexedDbStorage,
  storedAccessToken,
  type AuthStorage,
  type BrowserSupabase,
} from "@chalito/client";
import { KeyVault, httpApi } from "@chalito/client-keys";
import { unwrapKeyring, type RoomControllerDeps, type RoomsDb } from "@chalito/rooms";
import { loadStored, type DesktopEnv, type Stored } from "./session.js";

/** What every RoomController in the room window shares (all but the roomId). */
export type RoomWindowDeps = Omit<RoomControllerDeps, "roomId">;

export interface RoomWindowIo {
  storage: AuthStorage;
  /** The device keys (box secret) stay in the vault: only `keyring(rows)` touches them. */
  loadKeys: () => Promise<{ deviceId: string; box: { publicKey: Uint8Array; secretKey: Uint8Array } } | null>;
  account: () => Stored | null;
  supabase: (token: () => Promise<string | null>) => BrowserSupabase;
  api: (token: () => Promise<string | null>) => RoomControllerDeps["api"];
}

/**
 * The room window's connection, as this device, without a sign-in of its own: the panel owns
 * the session and refreshes it; this window borrows the access token from the shared storage
 * (two clients refreshing one rotating refresh token would race and sign the device out).
 * Null until the panel has signed in and enrolled this device.
 */
export const roomWindowDeps = async (io: RoomWindowIo): Promise<RoomWindowDeps | null> => {
  const account = io.account();
  const keys = await io.loadKeys();
  const token = storedAccessToken(io.storage);
  if (!account || !keys || !(await token())) return null;
  const db = io.supabase(token);
  const { data, error } = await (
    db as unknown as {
      from(t: "companions"): {
        select(c: "companion_id"): {
          eq(
            c: "owner",
            v: string,
          ): {
            maybeSingle(): PromiseLike<{ data: { companion_id?: unknown } | null; error: unknown }>;
          };
        };
      };
    }
  )
    .from("companions")
    .select("companion_id")
    .eq("owner", account.owner)
    .maybeSingle();
  if (error || typeof data?.companion_id !== "string") return null;
  return {
    db: db as unknown as RoomsDb,
    api: io.api(token),
    keyring: (rows) => unwrapKeyring(rows, keys.box),
    deviceId: keys.deviceId,
    companionId: data.companion_id,
  };
};

export const tauriRoomWindowIo = async (env: DesktopEnv): Promise<RoomWindowIo> => {
  const vault = await KeyVault.open("chalito-desktop-keys");
  return {
    storage: indexedDbStorage({ dbName: "chalito-desktop" }),
    loadKeys: () => vault.load(),
    account: loadStored,
    supabase: (token) => createBorrowedSupabase(env.supabaseUrl, env.supabaseKey, token),
    api: (token) => httpApi({ baseUrl: env.apiBase, token }),
  };
};
