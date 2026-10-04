/**
 * Shared plumbing for the agent's integration tests against the LOCAL Supabase stack
 * (`supabase start`; env from `supabase status -o env`). Never points at a hosted project.
 */
import { execFileSync } from "node:child_process";
import { createClient as createSupabase, type SupabaseClient } from "@supabase/supabase-js";

export const API_URL = process.env.API_URL ?? process.env.SUPABASE_URL ?? "";
export const ANON = process.env.PUBLISHABLE_KEY || process.env.ANON_KEY || "";
const SERVICE = process.env.SERVICE_ROLE_KEY ?? "";
export const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(API_URL) && !!ANON && !!SERVICE;

// No generated types for the chalito schema in tests: a deliberately loose client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = SupabaseClient<any, any, any>;
export const createClient = (url: string, key: string, opts: Record<string, unknown>): Db =>
  createSupabase(url, key, opts) as unknown as Db;

export const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Server-side SQL as chalito_server (what the API does). `supabase db query` runs ONE
 * statement per call, so the role switch and the statements go inside one DO block.
 */
export const serverSql = (sql: string) =>
  execFileSync(
    "supabase",
    ["db", "query", "--local", `do $srv$ begin set local role chalito_server; ${sql} end $srv$`],
    { stdio: "pipe" },
  );

const email = (device: string) => `${device.toLowerCase()}@devices.chalito.invalid`;

/** GoTrue admin (service key) for Auth users per device; never used for chalito data. */
export const gotrue = (): Db =>
  createClient(API_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

/** Creates the device's Auth user (app_metadata.chalito) and returns its id. */
export const createDeviceUser = async (admin: Db, owner: string, deviceId: string, role: "agent" | "client") => {
  const { data, error } = await admin.auth.admin.createUser({
    email: email(deviceId),
    email_confirm: true,
    app_metadata: { chalito: { owner, device_id: deviceId, role } },
  });
  if (error || !data.user) throw new Error(error?.message ?? "no user");
  return data.user.id;
};

/** A magic-link token_hash for the device's Auth user (what the API returns after the challenge). */
export const tokenHash = async (admin: Db, deviceId: string) => {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: email(deviceId) });
  if (error) throw new Error(error.message);
  return data.properties.hashed_token;
};

/** A chalito-schema client signed in as the device (magic-link exchange). */
export const deviceDb = async (admin: Db, deviceId: string): Promise<Db> => {
  const auth = createClient(API_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await auth.auth.verifyOtp({
    token_hash: await tokenHash(admin, deviceId),
    type: "magiclink",
  });
  if (error || !data.session) throw new Error(error?.message ?? "no session");
  const token = data.session.access_token;
  return createClient(API_URL, ANON, { db: { schema: "chalito" }, accessToken: async () => token });
};

export interface SeedDevice {
  deviceId: string;
  role: "agent" | "client";
  authUserId: string;
  pubSign?: string;
  pubBox?: string;
}

/** Tenant, user and devices, as chalito_server. */
export const seedOwner = (owner: string, devices: SeedDevice[], opts: { callBriefing?: boolean } = {}) => {
  const rows = devices
    .map(
      (d) =>
        `(${q(owner)}, ${q(d.deviceId)}, ${q(d.role)}, ${q(d.role === "agent" ? "desktop" : "phone")}, ${q(d.role === "agent" ? "linux" : "ios")}, ${q(d.deviceId.slice(0, 40))}, ${q(d.pubSign ?? "p")}, ${q(d.pubBox ?? "p")}, 'f', ${q(d.role === "agent" ? "pairing" : "first_client")}, ${q(d.authUserId)})`,
    )
    .join(", ");
  serverSql(`insert into chalito.tenants (id) values (${q(owner)});
    insert into chalito.users (id, tenant_id, call_briefing) values (${q(owner)}, ${q(owner)}, '{"enabled": ${opts.callBriefing ? "true" : "false"}}');
    insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
    values ${rows};`);
};

export const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
};
