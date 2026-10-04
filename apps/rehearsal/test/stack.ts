/**
 * The beta rehearsal's harness: the REAL api (createApp + PostgresRepo + SupabaseIssuer) on the
 * LOCAL Supabase stack, people built through the same routes the apps use (hub tenant → SSO → web
 * session → first phone → device session), passkeys from a SoftAuthenticator, and desktop agents
 * paired with a signed glyph. No production code is changed for any of this: the hub's side of the
 * SSO contract is plain config (an HMAC secret and the admin token), and outside services are
 * mocked at the network (msw) by the steps that need them.
 */
import { createHmac, randomUUID } from "node:crypto";
import { AuthClient, createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  deriveDeviceId,
  fingerprint,
  generateBoxKeyPair,
  generateSigningKeyPair,
  randomNonce,
  signEnvelope,
  toB64url,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import {
  approveEndorsement,
  httpApi,
  registerPasskey,
  resolveForEndorsement,
  type ApiClient,
  type DeviceSigner,
  type TrustedAgent,
} from "@chalito/client-keys";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import type { WebAuthnCredentialRef } from "@chalito/crypto";
import { signGlyph } from "@chalito/glyph";
import type { Endorsement, GlyphPayload } from "@chalito/protocol";
import { createApp } from "../../api/src/app.js";
import { MemoryAudit, type Deps } from "../../api/src/deps.js";
import { PostgresRepo, chalitoSql } from "../../api/src/postgres/repo.js";
import { PostgresRoomsRepo } from "../../api/src/rooms/repo.js";
import { SupabaseIssuer, chalitoAuthUserId } from "../../api/src/supabase/identity.js";

export const DB_URL = process.env.DATABASE_URL;
export const AUTH_URL = process.env.SUPABASE_AUTH_URL;
export const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const ROLE = process.env.CHALITO_DB_ROLE;
/** Only against the local stack: a non-local URL is refused. */
export const READY =
  !!(DB_URL && AUTH_URL && SERVICE && ANON) && /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(AUTH_URL ?? "");
export const SUPABASE_URL = (AUTH_URL ?? "").replace(/\/auth\/v1\/?$/, "");

const SSO_SECRET = "rehearsal-sso-secret";
const ADMIN = "rehearsal-admin-token";
const RECOVERY = "ABCDE-FGHJK-MNPQR-STVWX-YZ0123";
/** The default WebAuthn relying party (webauthnConfigFromEnv): what the phone's passkey is for. */
export const RP_ID = "chalito.chalyb.com";
export const ORIGIN = `https://${RP_ID}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = SupabaseClient<any, any, any>;

export interface Keys {
  sign: SigningKeyPair;
  box: BoxKeyPair;
  pubSign: string;
  pubBox: string;
  deviceId: string;
}

export interface Device extends Keys {
  token: string;
  db: Db;
  /** The api as this device (client-keys' HTTP client, routed to the in-process app). */
  api: ApiClient;
  /** This device's key as client-keys signs with it. */
  signer: DeviceSigner;
}

export interface Person {
  name: string;
  owner: string;
  /** The web session (hub SSO → Supabase session of the hub user). */
  userToken: string;
  phone: Device;
  /** The phone's passkey, once enrolled, and the credential its signed binding names. */
  passkey: SoftAuthenticator | null;
  credential: WebAuthnCredentialRef | null;
}

export const signerFor = (k: Keys): DeviceSigner => ({
  deviceId: k.deviceId,
  sign: (ctx, body) => signEnvelope(ctx, body, k.deviceId, k.sign.secretKey),
});

export const keys = async (): Promise<Keys> => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return {
    sign,
    box,
    pubSign: await toB64url(sign.publicKey),
    pubBox: await toB64url(box.publicKey),
    deviceId: await deriveDeviceId(sign.publicKey),
  };
};

export const createStack = () => {
  const sql = chalitoSql(DB_URL ?? "postgres://unused", { max: 5, ...(ROLE ? { role: ROLE } : {}) });
  const authAdmin = new AuthClient({
    url: AUTH_URL ?? "http://unused",
    headers: { apikey: SERVICE ?? "", Authorization: `Bearer ${SERVICE}` },
    autoRefreshToken: false,
    persistSession: false,
  });
  const audit = new MemoryAudit();
  let clock = Date.now();
  const now = () => clock;
  const deps = {
    repo: new PostgresRepo(sql, { authUserId: chalitoAuthUserId }),
    rooms: new PostgresRoomsRepo(sql),
    identity: new SupabaseIssuer(authAdmin),
    audit,
    config: { ssoSecret: SSO_SECRET, adminToken: ADMIN, recoveryCooldownMs: 60 * 60 * 1000, skewMs: 60_000 },
    now,
  } as Deps;
  const api = createApp(deps);
  const hubUsers: string[] = [];
  const clients: Db[] = [];

  const call = async (path: string, body: unknown, bearer?: string) => {
    const res = await api.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (text ? JSON.parse(text) : null) as any };
  };
  /** `fetch` for clients that talk to the api over HTTP (httpApi): routed to the in-process app. */
  const apiFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    api.request(String(input).replace(/^https?:\/\/[^/]+/, ""), init)) as typeof fetch;

  const ssoToken = (payload: object) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${createHmac("sha256", SSO_SECRET).update(body).digest("base64url")}`;
  };

  /** A magic-link token_hash (what the api returns) → a session and a chalito-schema client. */
  const signIn = async (tokenHash: string): Promise<{ db: Db; token: string }> => {
    const auth = new AuthClient({
      url: AUTH_URL!,
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
      autoRefreshToken: false,
      persistSession: false,
    });
    const { data, error } = await auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
    if (error || !data.session) throw error ?? new Error("no session");
    const token = data.session.access_token;
    const db = createClient(SUPABASE_URL, ANON, {
      db: { schema: "chalito" },
      accessToken: async () => token,
    }) as unknown as Db;
    await db.realtime.setAuth(token);
    clients.push(db);
    return { db, token };
  };

  const deviceSession = async (owner: string, k: Keys): Promise<Device> => {
    const res = await call(
      "/v1/devices/token",
      await signEnvelope(
        "chalito.refresh-challenge.v1",
        { v: 1 as const, owner, deviceId: k.deviceId, nonce: await randomNonce(), issuedAt: now() },
        k.deviceId,
        k.sign.secretKey,
      ),
    );
    if (res.status !== 200) throw new Error(`device token ${res.status} ${JSON.stringify(res.json)}`);
    const session = await signIn(res.json.customToken);
    return {
      ...k,
      ...session,
      api: httpApi({ baseUrl: "http://api.rehearsal.invalid", token: async () => session.token, fetch: apiFetch }),
      signer: signerFor(k),
    };
  };

  const registration = (owner: string, k: Keys, kind: "phone" | "web", name: string) =>
    signEnvelope(
      "chalito.device-register.v1",
      {
        v: 1 as const,
        owner,
        deviceId: k.deviceId,
        kind,
        platform: kind === "web" ? ("web" as const) : ("ios" as const),
        name,
        pubSign: k.pubSign,
        pubBox: k.pubBox,
        issuedAt: now(),
      },
      k.deviceId,
      k.sign.secretKey,
    );

  /**
   * Step 1's path: the hub provisions the tenant, its SSO launch signs the person into the web
   * (a Supabase session of the hub user), and the web enrols the first client device (the phone).
   */
  const person = async (name: string, tier = "plus"): Promise<Person> => {
    const { data, error } = await authAdmin.admin.createUser({
      email: `${name}-${randomUUID()}@example.invalid`,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("no hub user");
    const owner = data.user.id;
    hubUsers.push(owner);
    const tenant = await call(
      "/tenants",
      { external_user_id: owner, email: `${name}@example.com`, display_name: name, tier },
      ADMIN,
    );
    if (tenant.status !== 201) throw new Error(`tenant ${tenant.status}`);
    const sso = await call("/sso/exchange", {
      token: ssoToken({
        user_id: owner,
        email: `${name}@example.com`,
        tenant_id: owner,
        tier,
        exp: Math.floor(now() / 1000) + 300,
      }),
    });
    if (sso.status !== 200) throw new Error(`sso ${sso.status}`);
    const userToken = (await signIn(sso.json.customToken)).token;
    const k = await keys();
    const first = await call(
      "/v1/devices/first",
      { registration: await registration(owner, k, "phone", `Phone ${name}`), recoveryCode: RECOVERY },
      userToken,
    );
    if (first.status !== 201) throw new Error(`first device ${first.status} ${JSON.stringify(first.json)}`);
    return { name, owner, userToken, phone: await deviceSession(owner, k), passkey: null, credential: null };
  };

  /**
   * The phone enrols a passkey with the client's own flow (client-keys registerPasskey): WebAuthn
   * registration through the api, then the device-signed binding agents record it from.
   */
  const enrolPasskey = async (p: Person) => {
    const auth = new SoftAuthenticator({ origin: ORIGIN, alg: -8 });
    p.credential = await registerPasskey(p.phone.api, p.phone.signer, auth, now);
    p.passkey = auth;
    return auth;
  };

  /** A fresh step-up assertion from the phone's passkey (for revoke-all, endorsement…). */
  const stepUp = async (p: Person) => {
    const opts = await call("/v1/webauthn/assert/options", {}, p.phone.token);
    if (opts.status !== 200) throw new Error(`assert options ${opts.status}`);
    return p.passkey!.get(opts.json.options);
  };

  /**
   * Step 2's path: the desktop agent publishes a signed glyph, the phone claims it (the user saw the
   * fingerprint), and the agent gets its own credential by signing a one-time challenge.
   */
  const pairAgent = async (p: Person, label = "Laptop") => {
    const agent = await keys();
    const glyph: GlyphPayload = await signGlyph(
      {
        v: 1,
        purpose: "pair_device",
        codeId: `code_${(await randomNonce()).replace(/[^A-Za-z0-9]/g, "")}`,
        issuerPubSign: agent.pubSign,
        issuerPubBox: agent.pubBox,
        label,
        issuedAt: now(),
        expiresAt: now() + 5 * 60_000,
        nonce: await randomNonce(),
      },
      agent.sign.secretKey,
    );
    const published = await call("/v1/pairing/codes", { glyph, kind: "laptop", platform: "linux" });
    if (published.status !== 201) throw new Error(`pairing code ${published.status}`);
    const claim = await signEnvelope(
      "chalito.pairing-claim.v1",
      {
        v: 1 as const,
        owner: p.owner,
        codeId: glyph.body.codeId,
        agentDeviceId: agent.deviceId,
        agentFingerprint: await fingerprint(agent.sign.publicKey),
        claimerDeviceId: p.phone.deviceId,
        issuedAt: now(),
      },
      p.phone.deviceId,
      p.phone.sign.secretKey,
    );
    const claimed = await call("/v1/pairing/claim", { claim }, p.phone.token);
    if (claimed.status !== 200) throw new Error(`claim ${claimed.status} ${JSON.stringify(claimed.json)}`);
    return { glyph, shortCode: String(published.json.shortCode), device: await deviceSession(p.owner, agent) };
  };

  /** What a client keeps about an agent it confirmed with the glyph. */
  const agentRef = async (d: Keys, label: string): Promise<TrustedAgent> => ({
    deviceId: d.deviceId,
    pubSign: d.pubSign,
    pubBox: d.pubBox,
    fingerprint: await fingerprint(d.sign.publicKey),
    label,
    confirmedAt: now(),
    via: "glyph",
  });

  /**
   * Step 3's path as a helper: a new browser (signed into the web) is endorsed by the phone, with
   * its passkey step-up when it has one and the phone's agents introduced, then enrols.
   */
  const endorseBrowser = async (p: Person, agents: TrustedAgent[] = []) => {
    const browser = await keys();
    const registration = await registerBrowser(p, browser);
    const code = await call("/v1/endorse/codes", { registration }, p.userToken);
    if (code.status !== 201) throw new Error(`endorse code ${code.status}`);
    const target = await resolveForEndorsement(p.phone.api, { shortCode: code.json.shortCode }, now());
    await approveEndorsement(p.phone.api, p.phone.signer, target, {
      uid: p.owner,
      now: now(),
      ...(p.passkey ? { stepUp: p.passkey.stepUp(RP_ID) } : {}),
      agents,
    });
    const taken = await call("/v1/endorse/take", { codeId: code.json.codeId }, p.userToken);
    if (taken.status !== 200) throw new Error(`take ${taken.status}`);
    const endorsement = taken.json.endorsement as Endorsement;
    const enrolled = await call("/v1/devices/endorsed", { registration, endorsement }, p.userToken);
    if (enrolled.status !== 201) throw new Error(`endorsed ${enrolled.status} ${JSON.stringify(enrolled.json)}`);
    return { device: await deviceSession(p.owner, browser), endorsement };
  };
  const registerBrowser = (p: Person, k: Keys) => registration(p.owner, k, "web", "Navegador");

  const close = async () => {
    for (const c of clients) await c.removeAllChannels().catch(() => undefined);
    for (const id of hubUsers) await authAdmin.admin.deleteUser(id).catch(() => undefined);
    await sql.end();
  };

  return {
    sql,
    api,
    audit,
    deps,
    call,
    apiFetch,
    signIn,
    deviceSession,
    registration,
    person,
    enrolPasskey,
    stepUp,
    pairAgent,
    agentRef,
    endorseBrowser,
    close,
    now,
    tick: (ms: number) => void (clock += ms),
  };
};

export type Stack = ReturnType<typeof createStack>;
