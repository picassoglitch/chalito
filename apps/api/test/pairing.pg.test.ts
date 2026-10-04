/**
 * The Supabase counterpart of the old pairing.emu.test.ts: the hub contract, phone-first
 * enrolment, glyph pairing, device credentials, command delivery, endorsement, revocation
 * and recovery, end to end through the api's routes on PostgresRepo + SupabaseIssuer against
 * the LOCAL stack (`pnpm --filter @chalito/api test:pg` in the supabase CI job). Clients read
 * and listen as their own Supabase Auth users, under RLS, over private Realtime channels.
 */
import { createHmac, randomUUID } from "node:crypto";
import { AuthClient, createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deriveDeviceId,
  fingerprint,
  generateBoxKeyPair,
  generateSigningKeyPair,
  randomNonce,
  signEnvelope,
  toB64url,
  TrustedClientList,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import { GlyphDecoder, renderGlyphFrames, signGlyph } from "@chalito/glyph";
import type { GlyphPayload } from "@chalito/protocol";
import { createApp } from "../src/app.js";
import { MemoryAudit, type Deps } from "../src/deps.js";
import { PostgresRepo, chalitoSql } from "../src/postgres/repo.js";
import { SupabaseIssuer, chalitoAuthUserId } from "../src/supabase/identity.js";

const DB_URL = process.env.DATABASE_URL;
const AUTH_URL = process.env.SUPABASE_AUTH_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const ROLE = process.env.CHALITO_DB_ROLE;
const READY = !!(DB_URL && AUTH_URL && SERVICE && ANON);
const API_URL = (AUTH_URL ?? "").replace(/\/auth\/v1\/?$/, "");

const SSO_SECRET = "sso-secret-for-tests";
const ADMIN = "admin-token-for-tests";
const RECOVERY = "ABCDE-FGHJK-MNPQR-STVWX-YZ0123";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

describe.skipIf(!READY)("api end to end on Supabase (local stack)", () => {
  const sql = chalitoSql(DB_URL ?? "postgres://unused", { max: 5, ...(ROLE ? { role: ROLE } : {}) });
  const authAdmin = new AuthClient({
    url: AUTH_URL ?? "http://unused",
    headers: { apikey: SERVICE ?? "", Authorization: `Bearer ${SERVICE}` },
    autoRefreshToken: false,
    persistSession: false,
  });
  let clock = Date.now();
  const audit = new MemoryAudit();
  const api = createApp({
    repo: new PostgresRepo(sql, { authUserId: chalitoAuthUserId }),
    identity: new SupabaseIssuer(authAdmin),
    audit,
    config: { ssoSecret: SSO_SECRET, adminToken: ADMIN, recoveryCooldownMs: 60 * 60 * 1000, skewMs: 60_000 },
    now: () => clock,
  } as Deps);
  const clients: Db[] = [];
  let OWNER = "";

  const call = async (path: string, body: unknown, bearer?: string) => {
    const res = await api.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  /** Exchanges a magic-link token_hash (what the api returns) for a session; a chalito-schema client. */
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
    const db = createClient(API_URL, ANON, {
      db: { schema: "chalito" },
      accessToken: async () => token,
    }) as unknown as Db;
    db.realtime.setAuth(token);
    clients.push(db);
    return { db, token };
  };

  /** Resolves with the first broadcast on a private topic for which `check` passes. */
  const listen = (db: Db, topic: string, check: () => Promise<boolean>) =>
    new Promise<number>((resolve, reject) => {
      const ch = db
        .channel(topic, { config: { private: true } })
        .on("broadcast", { event: "*" }, () => {
          void check().then((ok) => {
            if (ok) {
              void db.removeChannel(ch);
              resolve(Date.now());
            }
          });
        })
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error(`${topic}: ${status}`));
        });
    });
  const joined = () => new Promise((r) => setTimeout(r, 1500));

  interface Keys {
    sign: SigningKeyPair;
    box: BoxKeyPair;
    pubSign: string;
    pubBox: string;
    deviceId: string;
  }
  const keys = async (): Promise<Keys> => {
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
  const registration = (k: Keys, kind: "phone" | "web", name = "iPhone de Aldo") =>
    signEnvelope(
      "chalito.device-register.v1",
      {
        v: 1 as const,
        owner: OWNER,
        deviceId: k.deviceId,
        kind,
        platform: "ios" as const,
        name,
        pubSign: k.pubSign,
        pubBox: k.pubBox,
        issuedAt: clock,
      },
      k.deviceId,
      k.sign.secretKey,
    );
  const deviceToken = async (k: Keys) =>
    call(
      "/v1/devices/token",
      await signEnvelope(
        "chalito.refresh-challenge.v1",
        { v: 1 as const, owner: OWNER, deviceId: k.deviceId, nonce: await randomNonce(), issuedAt: clock },
        k.deviceId,
        k.sign.secretKey,
      ),
    );
  const ssoToken = (payload: object) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${createHmac("sha256", SSO_SECRET).update(body).digest("base64url")}`;
  };

  let userToken = "";
  let phone: Keys;
  let phoneId = "";
  let phoneDb: Db;
  let phoneToken = "";
  let agent: Keys;
  let agentDb: Db;
  let glyph: GlyphPayload;
  let shortCode = "";
  let claimedSeen: Promise<number>;
  let watchDb: Db;

  beforeAll(async () => {
    // The hub user: a real Supabase Auth user in the hub project; Chalito's owner id is its id.
    const { data, error } = await authAdmin.admin.createUser({
      email: `hub-${randomUUID()}@example.invalid`,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("no hub user");
    OWNER = data.user.id;
  });

  afterAll(async () => {
    for (const c of clients) await c.removeAllChannels().catch(() => undefined);
    await authAdmin.admin.deleteUser(OWNER).catch(() => undefined);
    await sql.end();
  });

  describe("hub engine contract", () => {
    it("provisions a tenant; a repeat is a 409 carrying the same ids", async () => {
      const body = { external_user_id: OWNER, email: "aldo@example.com", display_name: "Aldo", tier: "pro" };
      expect((await call("/tenants", body, "wrong")).status).toBe(401);
      const first = await call("/tenants", body, ADMIN);
      expect(first.status).toBe(201);
      const again = await call("/tenants", body, ADMIN);
      expect(again.status).toBe(409);
      expect(again.json).toMatchObject({ error: "duplicate", tenant_id: OWNER, api_token: first.json.api_token });
      const status = await api.request(`/tenants/${OWNER}/status`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ status: "active" }),
      });
      expect(status.status).toBe(204);
    });

    it("exchanges a hub SSO token once for a Supabase session of the hub user", async () => {
      const token = ssoToken({
        user_id: OWNER,
        email: "aldo@example.com",
        tenant_id: OWNER,
        tier: "pro",
        exp: Math.floor(clock / 1000) + 300,
      });
      const res = await call("/sso/exchange", { token });
      expect(res.status).toBe(200);
      expect(res.json.owner).toBe(OWNER);
      userToken = (await signIn(res.json.customToken)).token;
      expect((await call("/sso/exchange", { token })).status).toBe(409);
    });
  });

  describe("phone-first enrolment", () => {
    beforeAll(async () => {
      phone = await keys();
    });

    it("enrols the first phone and refuses a second 'first' client", async () => {
      const res = await call(
        "/v1/devices/first",
        { registration: await registration(phone, "phone"), recoveryCode: RECOVERY },
        userToken,
      );
      expect(res.status).toBe(201);
      phoneId = res.json.deviceId;
      expect(phoneId).toBe(phone.deviceId);
      const other = await keys();
      expect(
        (
          await call(
            "/v1/devices/first",
            { registration: await registration(other, "phone"), recoveryCode: RECOVERY },
            userToken,
          )
        ).status,
      ).toBe(409);
    });

    it("refuses a registration whose id doesn't match its key", async () => {
      const k = await keys();
      const bad = await signEnvelope(
        "chalito.device-register.v1",
        {
          v: 1 as const,
          owner: OWNER,
          deviceId: phone.deviceId,
          kind: "web" as const,
          platform: "web" as const,
          name: "x",
          pubSign: k.pubSign,
          pubBox: k.pubBox,
          issuedAt: clock,
        },
        phone.deviceId,
        k.sign.secretKey,
      );
      expect((await call("/v1/devices/endorsed", { registration: bad, endorsement: {} }, userToken)).status).toBe(400);
    });
  });

  describe("pairing a desktop with the Chalito Glyph", () => {
    beforeAll(async () => {
      agent = await keys();
      const tok = await deviceToken(phone);
      expect(tok.status).toBe(200);
      ({ db: phoneDb, token: phoneToken } = await signIn(tok.json.customToken));
      glyph = await signGlyph(
        {
          v: 1,
          purpose: "pair_device",
          codeId: `code_${(await randomNonce()).replace(/[^A-Za-z0-9]/g, "")}`,
          issuerPubSign: agent.pubSign,
          issuerPubBox: agent.pubBox,
          label: "Laptop de Aldo",
          issuedAt: clock,
          expiresAt: clock + 5 * 60_000,
          nonce: await randomNonce(),
        },
        agent.sign.secretKey,
      );
    });

    it("the agent publishes its signed glyph and waits on its private pairing topic", async () => {
      const res = await call("/v1/pairing/codes", { glyph, kind: "laptop", platform: "linux" });
      expect(res.status).toBe(201);
      shortCode = res.json.shortCode;
      ({ db: watchDb } = await signIn(res.json.watchToken));
      claimedSeen = listen(watchDb, `chalito:pairing:${glyph.body.codeId}`, async () => {
        const { data } = await watchDb.from("pairing_codes").select("claimed").eq("code_id", glyph.body.codeId);
        return data?.[0]?.claimed === true;
      });
      await joined();
      expect((await call("/v1/pairing/codes", { glyph, kind: "laptop", platform: "linux" })).status).toBe(409);
    });

    it("the phone decodes the glyph from rendered frames (or the short code) and claims it", async () => {
      const decoder = new GlyphDecoder();
      let decoded: GlyphPayload | null = null;
      for (const img of renderGlyphFrames(glyph, 160, { rotationDeg: 17 })) decoded = decoder.pushImage(img) ?? decoded;
      expect(decoded).toEqual(glyph);
      const resolved = await call("/v1/pairing/resolve", { shortCode: shortCode.toLowerCase() }, phoneToken);
      expect(resolved.json.glyph).toEqual(glyph);

      const claim = await signEnvelope(
        "chalito.pairing-claim.v1",
        {
          v: 1 as const,
          owner: OWNER,
          codeId: glyph.body.codeId,
          agentDeviceId: agent.deviceId,
          agentFingerprint: await fingerprint(agent.sign.publicKey),
          claimerDeviceId: phoneId,
          issuedAt: clock,
        },
        phoneId,
        phone.sign.secretKey,
      );
      const t0 = Date.now();
      expect((await call("/v1/pairing/claim", { claim }, phoneToken)).status).toBe(200);
      expect((await claimedSeen) - t0).toBeLessThan(2000);
      // Reverse check material: the desktop reads the phone's key from its watched row.
      const { data } = await watchDb
        .from("pairing_codes")
        .select("claimer_pub_sign, owner")
        .eq("code_id", glyph.body.codeId)
        .single();
      expect(data).toEqual({ claimer_pub_sign: phone.pubSign, owner: OWNER });
      expect((await call("/v1/pairing/claim", { claim }, phoneToken)).json.error).toBe("already_claimed");
    });

    it("the agent gets its own credential by signing a one-time challenge; replays fail", async () => {
      const challenge = await signEnvelope(
        "chalito.refresh-challenge.v1",
        { v: 1 as const, owner: OWNER, deviceId: agent.deviceId, nonce: await randomNonce(), issuedAt: clock },
        agent.deviceId,
        agent.sign.secretKey,
      );
      const res = await call("/v1/devices/token", challenge);
      expect(res.status).toBe(200);
      ({ db: agentDb } = await signIn(res.json.customToken));
      expect((await call("/v1/devices/token", challenge)).json.error).toBe("replayed_nonce");
    });

    it("delivers a command from the phone to the agent over its private channel in under 2 s", async () => {
      const id = `cmd_${randomUUID().slice(0, 8)}`;
      const received = listen(agentDb, `chalito:device:${agent.deviceId}`, async () => {
        const { data } = await agentDb.from("commands").select("id").eq("id", id);
        return (data ?? []).length === 1;
      });
      await joined();
      const sent = Date.now();
      const { error } = await phoneDb.from("commands").insert({
        owner: OWNER,
        target_device_id: agent.deviceId,
        id,
        env: { ctx: "chalito.command.v1" },
        from_device_id: phoneId,
      });
      expect(error).toBeNull();
      expect((await received) - sent).toBeLessThan(2000);
    });

    it("rejects an expired code and a code whose fingerprint the user didn't see", async () => {
      const other = await keys();
      const g = await signGlyph(
        {
          ...glyph.body,
          codeId: `code_x${Date.now()}`,
          issuerPubSign: other.pubSign,
          issuerPubBox: other.pubBox,
          nonce: await randomNonce(),
        },
        other.sign.secretKey,
      );
      expect((await call("/v1/pairing/codes", { glyph: g, kind: "desktop", platform: "macos" })).status).toBe(201);
      const claimBody = {
        v: 1 as const,
        owner: OWNER,
        codeId: g.body.codeId,
        agentDeviceId: other.deviceId,
        agentFingerprint: await fingerprint(agent.sign.publicKey), // wrong device's fingerprint
        claimerDeviceId: phoneId,
        issuedAt: clock,
      };
      const wrongFp = await signEnvelope("chalito.pairing-claim.v1", claimBody, phoneId, phone.sign.secretKey);
      expect((await call("/v1/pairing/claim", { claim: wrongFp }, phoneToken)).json.error).toBe("fingerprint_mismatch");

      clock += 6 * 60_000;
      const late = await signEnvelope(
        "chalito.pairing-claim.v1",
        { ...claimBody, agentFingerprint: await fingerprint(other.sign.publicKey), issuedAt: clock },
        phoneId,
        phone.sign.secretKey,
      );
      expect((await call("/v1/pairing/claim", { claim: late }, phoneToken)).status).toBe(410);
      // Re-signing the expired glyph with a later timestamp is impossible without the agent key.
      expect((await call("/v1/pairing/codes", { glyph: g, kind: "desktop", platform: "macos" })).status).toBe(400);
    });

    it("a new phone needs an endorsement from a trusted one; the agent decides locally", async () => {
      const newPhone = await keys();
      const reg = await registration(newPhone, "web", "Navegador");
      const endorsement = await signEnvelope(
        "chalito.endorsement.v1",
        {
          v: 1 as const,
          uid: OWNER,
          newDeviceId: newPhone.deviceId,
          pubSign: newPhone.pubSign,
          pubBox: newPhone.pubBox,
          issuedAt: clock,
        },
        phoneId,
        phone.sign.secretKey,
      );
      expect((await call("/v1/devices/endorsed", { registration: reg, endorsement }, userToken)).status).toBe(201);
      const trusted = new TrustedClientList(agent.deviceId);
      await trusted.addConfirmed({ deviceId: phoneId, pubSign: phone.pubSign, pubBox: phone.pubBox }, clock);
      expect(trusted.has(newPhone.deviceId)).toBe(false);
      expect(await trusted.addEndorsed(endorsement, clock)).toBe(true);
    });

    it("revoking the agent blocks its very next read and its next credential", async () => {
      const before = await agentDb.from("devices").select("device_id").eq("device_id", agent.deviceId);
      expect(before.data).toHaveLength(1);
      expect((await call("/v1/devices/revoke", { deviceId: agent.deviceId }, phoneToken)).status).toBe(200);
      // RLS (device_ok) denies the revoked device on its next statement: it sees nothing.
      const after = await agentDb.from("devices").select("device_id");
      expect(after.data ?? []).toHaveLength(0);
      expect(
        (
          await call(
            "/v1/devices/token",
            await signEnvelope(
              "chalito.refresh-challenge.v1",
              { v: 1 as const, owner: OWNER, deviceId: agent.deviceId, nonce: await randomNonce(), issuedAt: clock },
              agent.deviceId,
              agent.sign.secretKey,
            ),
          )
        ).status,
      ).toBe(403);
      expect(audit.events.some((e) => e.action === "device.revoked" && e.target === agent.deviceId)).toBe(true);
    });
  });

  describe("only-client-lost recovery", () => {
    it("needs the recovery code and a cool-down, then enrols a phone that agents must still confirm", async () => {
      const lost = await keys();
      const reg = async () => registration(lost, "phone", "Teléfono nuevo");
      expect(
        (await call("/v1/recovery/start", { recoveryCode: "ABCDE-FGHJK-MNPQR-STVWX-YZ0999" }, userToken)).status,
      ).toBe(401);
      expect((await call("/v1/recovery/start", { recoveryCode: RECOVERY }, userToken)).status).toBe(200);
      const body = async () => ({
        recoveryCode: RECOVERY,
        registration: await reg(),
        newRecoveryCode: "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZZ",
      });
      expect((await call("/v1/recovery/complete", await body(), userToken)).status).toBe(425);
      const alerts = await sql`select nid from chalito.notifications where owner = ${OWNER} and source = 'security'`;
      expect(alerts.length).toBeGreaterThan(0);

      clock += 61 * 60_000;
      expect((await call("/v1/recovery/complete", await body(), userToken)).status).toBe(201);
      const [dev] = await sql`select enrolled_via from chalito.devices where device_id = ${lost.deviceId}`;
      expect(dev?.enrolled_via).toBe("recovery");
      expect((await call("/v1/recovery/start", { recoveryCode: RECOVERY }, userToken)).status).toBe(401);
      const trusted = new TrustedClientList("someAgent");
      await trusted.addConfirmed({ deviceId: phoneId, pubSign: phone.pubSign, pubBox: phone.pubBox }, clock);
      expect(trusted.has(lost.deviceId)).toBe(false);
    });
  });
});
