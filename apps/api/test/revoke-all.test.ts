import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  deriveDeviceId,
  generateBoxKeyPair,
  generateSigningKeyPair,
  randomNonce,
  revokeAllServerEntry,
  revokeBundleChallenge,
  signEnvelope,
  stepUpBodyHash,
  toB64url,
  type SigningKeyPair,
} from "@chalito/crypto";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import { CommandBody, type DeviceDoc, type SignedCommand } from "@chalito/protocol";
import { MemoryVoiceSessions } from "@chalito/billing";
import { MemoryAudit, type Deps } from "../src/deps.js";
import type { ApiRepo, StoredWebAuthnCredential, WebAuthnChallenge } from "../src/repo.js";
import { deviceRoutes } from "../src/routes/devices.js";
import { webauthnRoutes } from "../src/routes/webauthn.js";
import { owner } from "./contract/fixtures.js";

const RP = "chalito.chalyb.com";
const ORIGIN = `https://${RP}`;
const NOW = 1_790_000_000_000;
const WA = { rpId: RP, rpName: "Chalito", origins: [ORIGIN], challengeTtlMs: 60_000 };

interface Keys {
  deviceId: string;
  sign: SigningKeyPair;
}
const keys = async (): Promise<Keys> => {
  const sign = await generateSigningKeyPair();
  return { deviceId: await deriveDeviceId(sign.publicKey), sign };
};
const doc = async (o: string, k: Keys, role: DeviceDoc["role"]): Promise<DeviceDoc> =>
  ({
    v: 1,
    deviceId: k.deviceId,
    owner: o,
    role,
    kind: role === "agent" ? "laptop" : "phone",
    platform: role === "agent" ? "linux" : "android",
    name: role,
    pubSign: await toB64url(k.sign.publicKey),
    pubBox: await toB64url((await generateBoxKeyPair()).publicKey),
    revoked: false,
  }) as unknown as DeviceDoc;

/** The slice of ApiRepo revoke-all and the passkey routes use, in memory. */
const memoryRepo = (devices: DeviceDoc[]) => {
  const challenges = new Map<string, WebAuthnChallenge>();
  const creds = new Map<string, StoredWebAuthnCredential>();
  const commands: { owner: string; targetDeviceId: string; id: string; env: unknown }[] = [];
  const repo: Partial<ApiRepo> = {
    getDevice: async (o, id) => devices.find((d) => d.owner === o && d.deviceId === id) ?? null,
    revokeOtherClients: async (o, keep) => {
      const hit = devices.filter((d) => d.owner === o && d.role === "client" && !d.revoked && d.deviceId !== keep);
      for (const d of hit) (d as { revoked: boolean }).revoked = true;
      return hit.map((d) => d.deviceId).sort();
    },
    activeAgents: async (o) =>
      devices
        .filter((d) => d.owner === o && d.role === "agent" && !d.revoked)
        .map((d) => d.deviceId)
        .sort(),
    queueCommand: async (o, c) => {
      if (commands.some((x) => x.owner === o && x.id === c.id)) return false;
      commands.push({ owner: o, targetDeviceId: c.targetDeviceId, id: c.id, env: c.env });
      return true;
    },
    putWebAuthnChallenge: async (c) => void challenges.set(`${c.owner}/${c.deviceId}/${c.purpose}`, c),
    takeWebAuthnChallenge: async (o, d, p, now) => {
      const k = `${o}/${d}/${p}`;
      const c = challenges.get(k);
      challenges.delete(k);
      return c && c.expiresAt > now ? c.challenge : null;
    },
    setDeviceWebAuthn: async (o, d, cred) => (creds.set(`${o}/${d}`, cred), true),
    getDeviceWebAuthn: async (o, d) => creds.get(`${o}/${d}`) ?? null,
    bumpWebAuthnCounter: async (o, d, id, counter) => {
      const c = creds.get(`${o}/${d}`);
      if (!c || c.credentialId !== id) return "not_found";
      if (counter === 0 && c.counter === 0) return "ok";
      if (counter <= c.counter) return "cloned";
      creds.set(`${o}/${d}`, { ...c, counter });
      return "ok";
    },
  };
  return { repo: repo as ApiRepo, commands };
};

const setup = async () => {
  const o = owner();
  const [phone, tablet, web, agent, agent2] = await Promise.all([keys(), keys(), keys(), keys(), keys()]);
  const devices = [
    await doc(o, phone, "client"),
    await doc(o, tablet, "client"),
    await doc(o, web, "client"),
    await doc(o, agent, "agent"),
    await doc(o, agent2, "agent"),
  ];
  const mem = memoryRepo(devices);
  const audit = new MemoryAudit();
  const banned: string[] = [];
  const voiceSessions = new MemoryVoiceSessions();
  const settled: string[] = [];
  const hungUp: string[] = [];
  const tokens: Record<string, { uid: string; role: string; owner: string; deviceId: string }> = {
    phone: { uid: `d_${phone.deviceId}`, role: "client", owner: o, deviceId: phone.deviceId },
    tablet: { uid: `d_${tablet.deviceId}`, role: "client", owner: o, deviceId: tablet.deviceId },
  };
  const deps = {
    repo: mem.repo,
    identity: {
      verify: async (t: string) => {
        const c = tokens[t];
        if (!c) throw new Error("bad token");
        return c;
      },
      disableDevice: async (id: string) => (banned.push(id), true),
    },
    audit,
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => NOW,
    // Desktop voice: the panel is a client, so its open session ends with it (billed, hung up).
    voice: {
      sessions: voiceSessions,
      hub: {
        event: (p: { owner: string; admissionId: string; seconds: number; sourceId: string }) => ({
          source_id: p.sourceId,
          kind: "voice.seconds",
          provider: "openai",
          external_user_id: p.owner,
          amount: p.seconds,
          cost_usd_micros: p.seconds * 500,
          occurred_at: new Date(NOW).toISOString(),
          reservation_id: p.admissionId,
        }),
        settle: async (p: { admissionId: string }) => void settled.push(p.admissionId),
      },
      provider: { hangupCall: async (id: string) => void hungUp.push(id) },
    },
  } as unknown as Deps;
  const app = new Hono().route("/v1/devices", deviceRoutes(deps, WA)).route("/v1/webauthn", webauthnRoutes(deps, WA));
  const post = async (path: string, body: unknown, token: string) => {
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const auth = new SoftAuthenticator({ origin: ORIGIN, alg: -8 });
  const enrolPasskey = async () => {
    const opts = await post("/v1/webauthn/register/options", {}, "phone");
    expect(
      (await post("/v1/webauthn/register/verify", { response: await auth.create(opts.json.options) }, "phone")).status,
    ).toBe(201);
  };
  let n = 0;
  /** An unsigned revoke command (the client builds them all before the one ceremony). */
  const revokeBody = (target: string, client: string, by: Keys = phone, over: Partial<CommandBody> = {}) =>
    randomNonce().then((nonce): Record<string, unknown> => ({
      v: 1,
      cid: `cmd_${++n}`,
      uid: o,
      targetDeviceId: target,
      origin: `client:${by.deviceId}`,
      nonce,
      issuedAt: NOW,
      expiresAt: NOW + 5 * 60_000,
      payload: { type: "device.revokeClient", clientDeviceId: client },
      ...over,
    }));
  const signAs = (body: Record<string, unknown>, by: Keys = phone) =>
    signEnvelope(
      "chalito.command.v1",
      CommandBody.parse(body),
      by.deviceId,
      by.sign.secretKey,
    ) as Promise<SignedCommand>;
  /**
   * The client side of ADR 0020: a server challenge, L = [body hashes…, server entry], ONE
   * assertion over L, the bundle on every body, then each is signed by its signer.
   */
  const bundled = async (items: { body: Record<string, unknown>; by?: Keys; inBundle?: boolean }[] = []) => {
    const { options } = (await post("/v1/webauthn/assert/options", {}, "phone")).json;
    const L = [
      ...(await Promise.all(items.filter((i) => i.inBundle !== false).map((i) => stepUpBodyHash(i.body)))),
      await revokeAllServerEntry({ uid: o, deviceId: phone.deviceId, challenge: options.challenge }),
    ];
    const r = await auth.get({ ...options, challenge: await toB64url(await revokeBundleChallenge(L)) });
    const assertion = {
      credentialId: r.id,
      authenticatorData: r.response.authenticatorData,
      clientDataJSON: r.response.clientDataJSON,
      signature: r.response.signature,
    };
    const stepUp = { method: "webauthn" as const, at: NOW, assertion, bundle: L };
    const commands = [];
    for (const i of items) commands.push(await signAs({ ...i.body, stepUp }, i.by));
    return { stepUp, commands };
  };
  return {
    o,
    phone,
    tablet,
    web,
    agent,
    agent2,
    devices,
    mem,
    audit,
    banned,
    voiceSessions,
    settled,
    hungUp,
    post,
    enrolPasskey,
    auth,
    revokeBody,
    bundled,
  };
};

describe("POST /v1/devices/revoke-all", () => {
  it("needs a passkey on the calling client, and a fresh step-up", async () => {
    const s = await setup();
    expect((await s.post("/v1/devices/revoke-all", {}, "phone")).json.error).toBe("passkey_required");
    await s.enrolPasskey();
    expect(await s.post("/v1/devices/revoke-all", {}, "phone")).toMatchObject({
      status: 401,
      json: { error: "step_up_required" },
    });
    expect(s.devices.filter((d) => d.revoked)).toHaveLength(0);
  });

  it("revokes and bans every other client, keeps the caller and the agents, and queues the caller's signed commands", async () => {
    const s = await setup();
    await s.enrolPasskey();
    const req = await s.bundled([
      { body: await s.revokeBody(s.agent.deviceId, s.tablet.deviceId) },
      { body: await s.revokeBody(s.agent.deviceId, s.web.deviceId) },
      { body: await s.revokeBody(s.agent2.deviceId, s.tablet.deviceId) },
      { body: await s.revokeBody(s.agent2.deviceId, s.web.deviceId) },
    ]);
    const r = await s.post("/v1/devices/revoke-all", req, "phone");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, commandsQueued: 4, refused: [], banFailed: [] });
    expect(r.json.revoked).toEqual([s.tablet.deviceId, s.web.deviceId].sort());
    expect(s.banned.sort()).toEqual([s.tablet.deviceId, s.web.deviceId].sort());
    expect(s.devices.find((d) => d.deviceId === s.phone.deviceId)!.revoked).toBe(false);
    expect(s.devices.filter((d) => d.role === "agent").every((d) => !d.revoked)).toBe(true);
    expect(s.mem.commands.map((c) => c.targetDeviceId).sort()).toEqual(
      [s.agent.deviceId, s.agent.deviceId, s.agent2.deviceId, s.agent2.deviceId].sort(),
    );
    expect(s.audit.events.at(-1)).toMatchObject({
      action: "device.revoked_all",
      meta: { clients: 2, commandsQueued: 4 },
    });
    // The revoked tablet can't do anything any more (requireAuth checks the revoked flag).
    expect((await s.post("/v1/devices/revoke-all", {}, "tablet")).json.error).toBe("device_revoked");
  });

  it("refuses commands that aren't the caller's revokeClient to its own agents, or aren't in the bundle", async () => {
    const s = await setup();
    await s.enrolPasskey();
    const tamperedBody = await s.revokeBody(s.agent.deviceId, s.web.deviceId);
    const req = await s.bundled([
      { body: await s.revokeBody(s.agent.deviceId, s.web.deviceId, s.tablet), by: s.tablet }, // another client
      { body: await s.revokeBody(s.tablet.deviceId, s.web.deviceId) }, // target isn't an agent
      { body: await s.revokeBody(s.agent.deviceId, s.phone.deviceId) }, // the caller itself
      { body: await s.revokeBody(s.agent.deviceId, s.web.deviceId, s.phone, { expiresAt: NOW - 1 }) },
      { body: tamperedBody },
      { body: await s.revokeBody(s.agent2.deviceId, s.web.deviceId), inBundle: false }, // not covered
    ]);
    const t = req.commands[4]!;
    req.commands[4] = { ...t, body: { ...t.body, targetDeviceId: s.agent2.deviceId } };
    const r = await s.post("/v1/devices/revoke-all", req, "phone");
    expect(r.status).toBe(200);
    expect(r.json.commandsQueued).toBe(0);
    expect(r.json.refused).toHaveLength(6);
    expect(s.mem.commands).toEqual([]);
  });

  it("one assertion is good once: a replayed request, or an assertion over another bundle, is refused", async () => {
    const s = await setup();
    await s.enrolPasskey();
    const req = await s.bundled([{ body: await s.revokeBody(s.agent.deviceId, s.web.deviceId) }]);
    // An assertion whose bundle was changed after the ceremony doesn't verify.
    const forged = { ...req, stepUp: { ...req.stepUp, bundle: [...req.stepUp.bundle, "0".repeat(64)] } };
    expect(await s.post("/v1/devices/revoke-all", forged, "phone")).toMatchObject({
      status: 401,
      json: { error: "step_up_failed" },
    });
    expect(s.devices.filter((d) => d.revoked)).toHaveLength(0);
    // The server's challenge is single-use: the real request now fails too, and so does a replay.
    expect((await s.post("/v1/devices/revoke-all", req, "phone")).status).toBe(401);
    const fresh = await s.bundled([{ body: await s.revokeBody(s.agent.deviceId, s.web.deviceId) }]);
    expect((await s.post("/v1/devices/revoke-all", fresh, "phone")).status).toBe(200);
    expect((await s.post("/v1/devices/revoke-all", fresh, "phone")).status).toBe(401);
  });

  it("the old separate server assertion (no bundle) isn't accepted any more", async () => {
    const s = await setup();
    await s.enrolPasskey();
    const { options } = (await s.post("/v1/webauthn/assert/options", {}, "phone")).json;
    const old = await s.post("/v1/devices/revoke-all", { stepUp: await s.auth.get(options) }, "phone");
    expect(old).toMatchObject({ status: 400, json: { error: "bad_request" } });
    expect(s.devices.filter((d) => d.revoked)).toHaveLength(0);
  });

  it("ends the revoked clients' open desktop voice (billed to now, hung up, settled), not the caller's", async () => {
    const s = await setup();
    await s.enrolPasskey();
    const RID = "66666666-6666-4666-8666-666666666666";
    const open = (deviceId: string, sourceId: string, startedAt: number) =>
      s.voiceSessions.open({
        sourceId,
        owner: s.o,
        channel: "desktop",
        deviceId,
        reservationId: RID,
        model: "m",
        startedAt,
        maxSeconds: 1800,
        callId: `rtc_${deviceId.slice(0, 6)}`,
      });
    await open(s.tablet.deviceId, `voice_${"a".repeat(32)}`, NOW - 90_000);
    const r = await s.post("/v1/devices/revoke-all", await s.bundled(), "phone");
    expect(r.status).toBe(200);
    const tablet = s.voiceSessions.sessions.get(`voice_${"a".repeat(32)}`)!;
    expect(tablet.endedAt).toBe(NOW);
    expect(s.voiceSessions.events.map((e) => e.amount)).toEqual([90]);
    expect(s.hungUp).toEqual([`rtc_${s.tablet.deviceId.slice(0, 6)}`]);
    expect(s.settled).toEqual([RID]);
  });
});
