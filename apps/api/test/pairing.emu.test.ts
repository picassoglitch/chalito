import { createHmac } from "node:crypto";
import { deleteApp, initializeApp as initClientApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth as getClientAuth, signInWithCustomToken } from "firebase/auth";
import {
  addDoc,
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore as getClientFirestore,
  onSnapshot,
  type Firestore as ClientFirestore,
} from "firebase/firestore";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
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
import type { GlyphPayload, PairingCodeDoc } from "@chalito/protocol";
import { createApp } from "../src/app.js";
import { MemoryAudit, type Deps } from "../src/deps.js";

const PROJECT = "demo-chalito";
const SSO_SECRET = "sso-secret-for-tests";
const ADMIN = "admin-token-for-tests";
const OWNER = `hub-user-${Date.now()}`;

let clock = Date.now();
const audit = new MemoryAudit();
const adminApp = getApps()[0] ?? initializeApp({ projectId: PROJECT });
const deps: Deps = {
  db: getFirestore(adminApp),
  auth: getAuth(adminApp),
  audit,
  config: { ssoSecret: SSO_SECRET, adminToken: ADMIN, recoveryCooldownMs: 60 * 60 * 1000, skewMs: 60_000 },
  now: () => clock,
};
const api = createApp(deps);
const clientApps: FirebaseApp[] = [];

const call = async (path: string, body: unknown, bearer?: string) => {
  const res = await api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

/** A Firebase client (phone, agent) signed in with a custom token, against the emulators. */
const signIn = async (customToken: string): Promise<{ db: ClientFirestore; idToken: string }> => {
  const app = initClientApp({ projectId: PROJECT, apiKey: "demo-key" }, `c${clientApps.length}-${Math.random()}`);
  clientApps.push(app);
  const auth = getClientAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const db = getClientFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(":");
  connectFirestoreEmulator(db, host!, Number(port));
  const cred = await signInWithCustomToken(auth, customToken);
  return { db, idToken: await cred.user.getIdToken() };
};

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
const RECOVERY = "ABCDE-FGHJK-MNPQR-STVWX-YZ0123";

let userIdToken = "";
let phone: Keys;
let phoneId = "";
let agent: Keys;
let agentDb: ClientFirestore;
let agentIdToken = "";
let glyph: GlyphPayload;
let shortCode = "";

afterAll(async () => {
  await Promise.all(clientApps.map((a) => deleteApp(a)));
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
    const paused = await api.request(`/tenants/${OWNER}/status`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ status: "active" }),
    });
    expect(paused.status).toBe(204);
  });

  it("exchanges a hub SSO token once for a Firebase session", async () => {
    const token = ssoToken({
      user_id: OWNER,
      email: "aldo@example.com",
      tenant_id: OWNER,
      tier: "pro",
      exp: Math.floor(clock / 1000) + 300,
    });
    const res = await call("/sso/exchange", { token });
    expect(res.status).toBe(200);
    userIdToken = (await signIn(res.json.customToken)).idToken;
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
      userIdToken,
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
          userIdToken,
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
    expect((await call("/v1/devices/endorsed", { registration: bad, endorsement: {} }, userIdToken)).status).toBe(400);
  });
});

describe("pairing a desktop with the Chalito Glyph", () => {
  let phoneDb: ClientFirestore;
  let phoneIdToken = "";
  let claimedSeen: Promise<PairingCodeDoc>;

  beforeAll(async () => {
    agent = await keys();
    const tok = await deviceToken(phone);
    ({ db: phoneDb, idToken: phoneIdToken } = await signIn(tok.json.customToken));
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

  it("the agent publishes its signed glyph and waits on a scoped listener", async () => {
    const res = await call("/v1/pairing/codes", { glyph, kind: "laptop", platform: "linux" });
    expect(res.status).toBe(201);
    shortCode = res.json.shortCode;
    const { db } = await signIn(res.json.watchToken);
    claimedSeen = new Promise((resolve) => {
      const stop = onSnapshot(doc(db, `pairingCodes/${glyph.body.codeId}`), (snap) => {
        const d = snap.data() as PairingCodeDoc | undefined;
        if (d?.claimed) {
          stop();
          resolve(d);
        }
      });
    });
    expect((await call("/v1/pairing/codes", { glyph, kind: "laptop", platform: "linux" })).status).toBe(409);
  });

  it("the phone decodes the glyph from rendered frames (or the short code) and claims it", async () => {
    // Camera path: decode the animated ring frames the desktop renders.
    const decoder = new GlyphDecoder();
    let decoded: GlyphPayload | null = null;
    for (const img of renderGlyphFrames(glyph, 160, { rotationDeg: 17 })) decoded = decoder.pushImage(img) ?? decoded;
    expect(decoded).toEqual(glyph);
    // Accessibility path: the short code resolves to the same payload.
    const resolved = await call("/v1/pairing/resolve", { shortCode: shortCode.toLowerCase() }, phoneIdToken);
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
    expect((await call("/v1/pairing/claim", { claim }, phoneIdToken)).status).toBe(200);
    const seen = await claimedSeen;
    expect(Date.now() - t0).toBeLessThan(2000);
    // Reverse check material: the desktop shows the phone's fingerprint from the doc.
    expect(seen.claimerPubSign).toBe(phone.pubSign);
    expect(seen.owner).toBe(OWNER);
    expect((await call("/v1/pairing/claim", { claim }, phoneIdToken)).json.error).toBe("already_claimed");
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
    ({ db: agentDb, idToken: agentIdToken } = await signIn(res.json.customToken));
    expect((await call("/v1/devices/token", challenge)).json.error).toBe("replayed_nonce");
  });

  it("delivers a command from the phone to the agent through a Firestore listener in under 2 s", async () => {
    const received = new Promise<number>((resolve) => {
      const stop = onSnapshot(collection(agentDb, `users/${OWNER}/devices/${agent.deviceId}/commands`), (snap) => {
        if (!snap.empty) {
          stop();
          resolve(Date.now());
        }
      });
    });
    const sent = Date.now();
    await addDoc(collection(phoneDb, `users/${OWNER}/devices/${agent.deviceId}/commands`), {
      env: { ctx: "chalito.command.v1" },
      createdAt: clock,
      fromDeviceId: phoneId,
    });
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
    expect((await call("/v1/pairing/claim", { claim: wrongFp }, phoneIdToken)).json.error).toBe("fingerprint_mismatch");

    clock += 6 * 60_000;
    const late = await signEnvelope(
      "chalito.pairing-claim.v1",
      { ...claimBody, agentFingerprint: await fingerprint(other.sign.publicKey), issuedAt: clock },
      phoneId,
      phone.sign.secretKey,
    );
    expect((await call("/v1/pairing/claim", { claim: late }, phoneIdToken)).status).toBe(410);
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
    expect((await call("/v1/devices/endorsed", { registration: reg, endorsement }, userIdToken)).status).toBe(201);

    // The agent's own list: the phone after the reverse check, the browser only via the endorsement.
    const trusted = new TrustedClientList(agent.deviceId);
    await trusted.addConfirmed({ deviceId: phoneId, pubSign: phone.pubSign, pubBox: phone.pubBox }, clock);
    expect(trusted.has(newPhone.deviceId)).toBe(false);
    expect(await trusted.addEndorsed(endorsement, clock)).toBe(true);
  });

  it("revoking the agent blocks its very next read", async () => {
    await expect(getDoc(doc(agentDb, `users/${OWNER}/devices/${agent.deviceId}`))).resolves.toBeDefined();
    expect((await call("/v1/devices/revoke", { deviceId: agent.deviceId }, phoneIdToken)).status).toBe(200);
    await expect(getDoc(doc(agentDb, `users/${OWNER}/devices/${agent.deviceId}`))).rejects.toMatchObject({
      code: "permission-denied",
    });
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
    expect(agentIdToken).not.toBe("");
    expect(audit.events.some((e) => e.action === "device.revoked" && e.target === agent.deviceId)).toBe(true);
  });
});

describe("only-client-lost recovery", () => {
  it("needs the recovery code and a cool-down, then enrols a phone that agents must still confirm", async () => {
    const lost = await keys();
    const reg = async () => registration(lost, "phone", "Teléfono nuevo");
    expect(
      (await call("/v1/recovery/start", { recoveryCode: "ABCDE-FGHJK-MNPQR-STVWX-YZ0999" }, userIdToken)).status,
    ).toBe(401);
    const started = await call("/v1/recovery/start", { recoveryCode: RECOVERY }, userIdToken);
    expect(started.status).toBe(200);
    const body = async () => ({
      recoveryCode: RECOVERY,
      registration: await reg(),
      newRecoveryCode: "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZZ",
    });
    expect((await call("/v1/recovery/complete", await body(), userIdToken)).status).toBe(425);
    const alert = await deps.db.collection(`users/${OWNER}/notifications`).where("source", "==", "security").get();
    expect(alert.empty).toBe(false);

    clock += 61 * 60_000;
    const done = await call("/v1/recovery/complete", await body(), userIdToken);
    expect(done.status).toBe(201);
    const devDoc = await deps.db.doc(`users/${OWNER}/devices/${lost.deviceId}`).get();
    expect(devDoc.get("enrolledVia")).toBe("recovery");
    // The old code no longer works.
    expect((await call("/v1/recovery/start", { recoveryCode: RECOVERY }, userIdToken)).status).toBe(401);
    // An agent that never confirmed this phone still doesn't trust it.
    const trusted = new TrustedClientList("someAgent");
    await trusted.addConfirmed({ deviceId: phoneId, pubSign: phone.pubSign, pubBox: phone.pubBox }, clock);
    expect(trusted.has(lost.deviceId)).toBe(false);
  });
});
