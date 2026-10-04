import { createClient } from "@supabase/supabase-js";
import { ClientActions, type ClientActionsOptions } from "./actions.js";
import type { ClientKeys } from "./keys.js";
import { LiveStore, type LiveStoreOptions } from "./live.js";
import type { SupaClient } from "./supa.js";

// ---------------------------------------------------------------- storage

/** The async key-value shape supabase-js auth accepts as `storage`. */
export interface AuthStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Key under which the browser keeps its Supabase Auth session (refresh token inside). */
export const BROWSER_SESSION_KEY = "chalito-supabase-session";

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/**
 * Supabase Auth session storage in IndexedDB (not localStorage: off the synchronous,
 * extension-visible store, and alongside the non-extractable keys the keys slice keeps
 * there). Any script running on the origin can still read it; the keys slice's step-up
 * and signatures are what make an approval binding, not this session.
 */
export const indexedDbStorage = (opts: { dbName?: string; idb?: IDBFactory } = {}): AuthStorage => {
  const idb = opts.idb ?? globalThis.indexedDB;
  const name = opts.dbName ?? "chalito";
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = idb.open(name, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains("auth")) open.result.createObjectStore("auth");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    }));
  const store = async (mode: IDBTransactionMode) => (await db()).transaction("auth", mode).objectStore("auth");
  return {
    getItem: async (key) => ((await req((await store("readonly")).get(key))) as string | undefined) ?? null,
    setItem: async (key, value) => void (await req((await store("readwrite")).put(value, key))),
    removeItem: async (key) => void (await req((await store("readwrite")).delete(key))),
  };
};

/** In-memory storage (tests, or a session that must not outlive the tab). */
export const memoryStorage = (): AuthStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (k) => values.get(k) ?? null,
    setItem: async (k, v) => void values.set(k, v),
    removeItem: async (k) => void values.delete(k),
  };
};

// ---------------------------------------------------------------- auth

interface AuthSession {
  access_token: string;
}
interface AuthError {
  message: string;
}
/** The slice of supabase-js `auth` used here (a fake in tests). */
export interface BrowserAuth {
  verifyOtp(p: { token_hash: string; type: "magiclink" }): Promise<{
    data: { session: AuthSession | null };
    error: AuthError | null;
  }>;
  setSession(p: { access_token: string; refresh_token: string }): Promise<{
    data: { session: AuthSession | null };
    error: AuthError | null;
  }>;
  getSession(): Promise<{ data: { session: AuthSession | null }; error: AuthError | null }>;
  onAuthStateChange(cb: (event: string, session: AuthSession | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
  signOut?(): Promise<unknown>;
}

/** What the browser client needs from supabase-js. */
export type BrowserSupabase = SupaClient & {
  auth: BrowserAuth;
  realtime: { setAuth(token?: string | null): unknown };
  removeAllChannels(): Promise<unknown>;
};

/**
 * How this browser gets a session:
 * - `sso`: a person's web session from the hub SSO exchange (/auth/sso). The API answers
 *   either with a magic-link `token_hash` or with a session pair.
 * - `device`: a trusted client device signs in as its own Supabase Auth user, like the
 *   agent: a signed challenge at Chalito's API returns a magic-link `token_hash`.
 */
export type SignIn =
  | {
      kind: "sso";
      exchange: () => Promise<{ token_hash: string } | { access_token: string; refresh_token: string }>;
    }
  | { kind: "device"; login: () => Promise<string> };

export class DeviceRevokedError extends Error {
  override name = "DeviceRevokedError";
  constructor() {
    super("This device was removed from your Chalito account. Pair it again from a trusted device.");
  }
}

const revoked = (err: unknown) => {
  const e = err as { code?: unknown; status?: unknown } | null;
  return e?.code === "device_revoked" || e?.status === 403;
};

/** Restores the stored session (supabase-js refreshes it if needed), or signs in fresh. */
export const ensureSession = async (auth: BrowserAuth, signIn: SignIn): Promise<string> => {
  const { data, error } = await auth.getSession();
  if (!error && data.session?.access_token) return data.session.access_token;
  let res: Awaited<ReturnType<BrowserAuth["verifyOtp"]>>;
  if (signIn.kind === "device") {
    let tokenHash: string;
    try {
      tokenHash = await signIn.login();
    } catch (err) {
      if (revoked(err)) throw new DeviceRevokedError();
      throw err;
    }
    res = await auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  } else {
    const x = await signIn.exchange();
    res =
      "token_hash" in x
        ? await auth.verifyOtp({ token_hash: x.token_hash, type: "magiclink" })
        : await auth.setSession({ access_token: x.access_token, refresh_token: x.refresh_token });
  }
  if (res.error || !res.data.session) throw new Error(`Supabase sign-in failed: ${res.error?.message ?? "no session"}`);
  return res.data.session.access_token;
};

export const createBrowserSupabase = (url: string, publishableKey: string, storage: AuthStorage): BrowserSupabase =>
  createClient(url, publishableKey, {
    db: { schema: "chalito" },
    auth: {
      storage,
      storageKey: BROWSER_SESSION_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  }) as unknown as BrowserSupabase;

// ---------------------------------------------------------------- bootstrap

export interface ConnectOptions {
  url: string;
  publishableKey: string;
  keys: ClientKeys;
  owner: string;
  signIn: SignIn;
  stepUp: ClientActionsOptions["stepUp"];
  storage?: AuthStorage;
  live?: LiveStoreOptions;
  actions?: Omit<ClientActionsOptions, "stepUp">;
  /** Injected in tests. */
  create?: (url: string, publishableKey: string, storage: AuthStorage) => BrowserSupabase;
}

export interface ChalitoClient {
  live: LiveStore;
  actions: ClientActions;
  close(): Promise<void>;
}

/**
 * Signs in (or restores the session), hands every new access token to Realtime, joins this
 * device's channel and returns the live store plus the actions.
 */
export const connect = async (o: ConnectOptions): Promise<ChalitoClient> => {
  const storage = o.storage ?? indexedDbStorage();
  const sb = (o.create ?? createBrowserSupabase)(o.url, o.publishableKey, storage);
  const token = await ensureSession(sb.auth, o.signIn);
  sb.realtime.setAuth(token);
  const sub = sb.auth.onAuthStateChange((_event, session) => {
    // Realtime caches join authorization until it sees a new token.
    if (session?.access_token) sb.realtime.setAuth(session.access_token);
  }).data.subscription;
  const live = new LiveStore(sb, o.keys, o.owner, o.live);
  const actions = new ClientActions(sb, o.keys, live, { ...o.actions, stepUp: o.stepUp });
  live.start();
  return {
    live,
    actions,
    close: async () => {
      sub.unsubscribe();
      await live.stop();
      await sb.removeAllChannels().catch(() => undefined);
    },
  };
};
