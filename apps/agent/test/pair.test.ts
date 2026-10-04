import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveDeviceId,
  fingerprint,
  generateBoxKeyPair,
  generateSigningKeyPair,
  signEnvelope,
  toB64url,
} from "@chalito/crypto";
import { verifyGlyph } from "@chalito/glyph";
import type { GlyphPayload, PairingCodeDoc } from "@chalito/protocol";
import { ApiRequestError, type FetchFn, type PairingWatcher } from "../src/cloud.js";
import { configPath, readConfig } from "../src/config.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { runPair, type PairDeps } from "../src/pair.js";
import { MemorySecretStore } from "../src/secrets.js";
import { TrustStore } from "../src/trust-store.js";

const NOW = 1_790_000_000_000;

const phoneKeys = async () => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return {
    sign,
    deviceId: await deriveDeviceId(sign.publicKey),
    pubSign: await toB64url(sign.publicKey),
    pubBox: await toB64url(box.publicKey),
    fingerprint: await fingerprint(sign.publicKey),
  };
};

type Phone = Awaited<ReturnType<typeof phoneKeys>>;
/** The phone's passkey binding, signed by `signer` (the phone itself unless forged). */
const passkeyBinding = (phone: Phone, signer: Phone = phone) =>
  signEnvelope(
    "chalito.webauthn-binding.v1",
    {
      v: 1 as const,
      deviceId: phone.deviceId,
      credentialId: "cGFzc2tleS1pZC1vZi10aGUtcGhvbmU",
      publicKey: "cHViLWtleQ",
      rpId: "chalito.chalyb.com",
      issuedAt: NOW,
    },
    phone.deviceId,
    signer.sign.secretKey,
  );

/** The control plane + Firestore, played by the test. */
const world = async (
  opts: {
    owner?: string;
    claim?: "valid" | "wrong_key" | "never";
    ttlMs?: number;
    passkey?: "valid" | "forged" | "none";
  } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "chalito-pair-"));
  writeFileSync(
    configPath(dir),
    JSON.stringify({ apiBase: "https://api.test", supabase: { url: "http://127.0.0.1:54321", publishableKey: "k" } }),
  );
  const phone = await phoneKeys();
  const other = await phoneKeys();
  let glyph: GlyphPayload | null = null;
  const requests: { url: string; body: unknown }[] = [];
  const fetch: FetchFn = async (url, init) => {
    const body = JSON.parse(init.body) as { glyph: GlyphPayload; kind: string; platform: string };
    requests.push({ url, body });
    expect(await verifyGlyph(body.glyph, NOW)).toEqual({ ok: true });
    glyph = body.glyph;
    return {
      ok: true,
      status: 201,
      json: async () => ({
        shortCode: "7K3M-QX9P",
        watchToken: "watch-token",
        expiresAt: NOW + (opts.ttlMs ?? 300_000),
      }),
    };
  };
  const watched: { token: string; codeId: string; stopped: boolean }[] = [];
  const watcher: PairingWatcher = {
    watch: async (token, codeId, onDoc) => {
      const w = { token, codeId, stopped: false };
      watched.push(w);
      if (opts.claim !== "never") {
        const g = glyph!;
        const claimer = opts.claim === "wrong_key" ? { ...phone, pubSign: other.pubSign } : phone;
        const unclaimed = {
          claimed: false,
          owner: null,
          claimedByDeviceId: null,
          claimerPubSign: null,
          claimerPubBox: null,
          claimerWebauthnBinding: null,
        };
        const doc: PairingCodeDoc = {
          v: 1,
          codeId,
          shortCodeHash: "0".repeat(64),
          glyph: g,
          agentDeviceId: await deriveDeviceId(Buffer.from(g.body.issuerPubSign, "base64url")),
          kind: "desktop",
          platform: "linux",
          ...unclaimed,
          expiresAt: g.body.expiresAt,
        };
        const binding =
          opts.passkey === "valid"
            ? await passkeyBinding(phone)
            : opts.passkey === "forged"
              ? await passkeyBinding(phone, other)
              : null;
        setTimeout(() => onDoc(doc), 5);
        setTimeout(
          () =>
            onDoc({
              ...doc,
              claimed: true,
              owner: opts.owner ?? "hub-user-1",
              claimedByDeviceId: claimer.deviceId,
              claimerPubSign: claimer.pubSign,
              claimerPubBox: claimer.pubBox,
              claimerWebauthnBinding: binding,
            }),
          15,
        );
      }
      return async () => void (w.stopped = true);
    },
  };
  const secrets = new MemorySecretStore();
  let out = "";
  const asked: string[] = [];
  const typed: string[] = [];
  const deps = (confirm: boolean, o: { os?: boolean; typed?: string } = {}): PairDeps => ({
    dir,
    env: {},
    secrets,
    fetch,
    watcher,
    confirm: async (q) => (asked.push(q), confirm),
    confirmTyped: async (q, phrase) => (typed.push(q), (o.typed ?? phrase) === phrase),
    osAuth: { verify: async () => o.os ?? true },
    out: (s) => void (out += s),
    now: () => NOW,
    hostname: "aldo-desktop",
    platform: "linux",
  });
  return { dir, phone, secrets, deps, requests, watched, out: () => out, asked, typed };
};

describe("chalito pair", () => {
  it("publishes a signed 5-minute glyph, shows the short code + fingerprints, and trusts the phone only after a local yes", async () => {
    const w = await world();
    const res = await runPair(w.deps(true));
    const id = await loadOrCreateIdentity(w.secrets);
    expect(res).toEqual({ ok: true, owner: "hub-user-1", deviceId: id.deviceId, phoneDeviceId: w.phone.deviceId });

    const req = w.requests[0]!;
    expect(req.url).toBe("https://api.test/v1/pairing/codes");
    const body = req.body as { glyph: GlyphPayload; kind: string; platform: string };
    expect(body).toMatchObject({ kind: "desktop", platform: "linux" });
    expect(body.glyph.body).toMatchObject({
      purpose: "pair_device",
      label: "aldo-desktop",
      issuerPubSign: id.pubSign,
      issuerPubBox: id.pubBox,
      expiresAt: NOW + 5 * 60 * 1000,
    });

    expect(w.out()).toContain("7K3M-QX9P");
    expect(w.out()).toContain(id.fingerprint);
    expect(w.out()).toContain(w.phone.fingerprint);
    expect(w.asked).toHaveLength(1);
    expect(w.watched).toEqual([{ token: "watch-token", codeId: body.glyph.body.codeId, stopped: true }]);

    const trust = await new TrustStore(w.dir, id.sign, id.deviceId).load();
    expect(trust.tampered).toBe(false);
    expect(trust.list.toJSON()).toMatchObject([
      { deviceId: w.phone.deviceId, pubSign: w.phone.pubSign, via: "local_confirmation" },
    ]);
    expect(readConfig(w.dir, {})).toMatchObject({ owner: "hub-user-1", deviceId: id.deviceId });
  });

  it("answering no adds nothing and leaves the computer unpaired", async () => {
    const w = await world();
    expect(await runPair(w.deps(false))).toEqual({ ok: false, reason: "rejected_locally" });
    expect(existsSync(join(w.dir, "trusted-clients.json"))).toBe(false);
    expect(readConfig(w.dir, {}).owner).toBeNull();
  });

  it("a claim whose phone key doesn't match its device id is refused before asking", async () => {
    const w = await world({ claim: "wrong_key" });
    expect(await runPair(w.deps(true))).toEqual({ ok: false, reason: "bad_claim" });
    expect(w.asked).toHaveLength(0);
    expect(existsSync(join(w.dir, "trusted-clients.json"))).toBe(false);
  });

  it("an unclaimed code expires", async () => {
    const w = await world({ claim: "never", ttlMs: 30 });
    expect(await runPair(w.deps(true))).toEqual({ ok: false, reason: "expired" });
    expect(w.watched[0]!.stopped).toBe(true);
  });

  it("pairing to a different account starts a fresh trusted list", async () => {
    const w = await world({ owner: "hub-user-1" });
    await runPair(w.deps(true));
    const w2Phone = await phoneKeys();
    // Same computer (same keychain + dir), new account and phone.
    const again = await world({ owner: "hub-user-2" });
    const deps = { ...again.deps(true), dir: w.dir, secrets: w.secrets };
    const firstPhone = w.phone.deviceId;
    expect((await runPair(deps)).ok).toBe(true);
    expect(again.typed).toHaveLength(1);
    expect(again.out()).toMatch(/hub-user-1 → hub-user-2/);
    const id = await loadOrCreateIdentity(w.secrets);
    const list = (await new TrustStore(w.dir, id.sign, id.deviceId).load()).list.toJSON().map((c) => c.deviceId);
    expect(list).toEqual([again.phone.deviceId]);
    expect(list).not.toContain(firstPhone);
    expect(w2Phone.deviceId).not.toBe(firstPhone);
    expect(readConfig(w.dir, {}).owner).toBe("hub-user-2");
  });

  it("needs OS authentication before anything is published", async () => {
    const w = await world();
    expect(await runPair(w.deps(true, { os: false }))).toEqual({ ok: false, reason: "os_auth_failed" });
    expect(w.requests).toHaveLength(0);
  });

  it("replacing the account without the typed phrase changes nothing", async () => {
    const w = await world({ owner: "hub-user-1" });
    await runPair(w.deps(true));
    const again = await world({ owner: "attacker" });
    const res = await runPair({ ...again.deps(true, { typed: "y" }), dir: w.dir, secrets: w.secrets });
    expect(res).toEqual({ ok: false, reason: "replace_declined" });
    const id = await loadOrCreateIdentity(w.secrets);
    expect(readConfig(w.dir, {}, { keys: id.sign }).owner).toBe("hub-user-1");
    expect((await new TrustStore(w.dir, id.sign, id.deviceId).load()).list.toJSON()).toHaveLength(1);
  });

  it("re-pairing to the same account needs no typed phrase and keeps the trusted phones", async () => {
    const w = await world({ owner: "hub-user-1" });
    await runPair(w.deps(true));
    const again = await world({ owner: "hub-user-1" });
    expect((await runPair({ ...again.deps(true), dir: w.dir, secrets: w.secrets })).ok).toBe(true);
    expect(again.typed).toHaveLength(0);
    const id = await loadOrCreateIdentity(w.secrets);
    expect((await new TrustStore(w.dir, id.sign, id.deviceId).load()).list.toJSON()).toHaveLength(2);
  });

  it("an owner forged into an unsigned config.json doesn't count: the replacement still needs the phrase", async () => {
    const w = await world({ owner: "hub-user-1" });
    await runPair(w.deps(true));
    const raw = JSON.parse(readFileSync(configPath(w.dir), "utf8"));
    writeFileSync(configPath(w.dir), JSON.stringify({ ...raw, owner: "attacker" }));
    const again = await world({ owner: "attacker" });
    const res = await runPair({ ...again.deps(true, { typed: "nope" }), dir: w.dir, secrets: w.secrets });
    expect(res).toEqual({ ok: false, reason: "replace_declined" });
  });

  it("surfaces API errors with the API's code", async () => {
    const w = await world();
    const deps = {
      ...w.deps(true),
      fetch: (async () => ({ ok: false, status: 429, json: async () => ({ error: "rate_limited" }) })) as FetchFn,
    };
    await expect(runPair(deps)).rejects.toBeInstanceOf(ApiRequestError);
    await expect(runPair(deps)).rejects.toThrow("rate_limited");
  });

  it("records the phone's passkey from its binding, shown in the local confirmation", async () => {
    const w = await world({ passkey: "valid" });
    expect((await runPair(w.deps(true))).ok).toBe(true);
    expect(w.out()).toContain("Llave de acceso (passkey) del teléfono: cGFzc2…vbmU");
    const id = await loadOrCreateIdentity(w.secrets);
    const trust = await new TrustStore(w.dir, id.sign, id.deviceId).load();
    expect(trust.list.webauthnFor(w.phone.deviceId)).toEqual({
      credentialId: "cGFzc2tleS1pZC1vZi10aGUtcGhvbmU",
      publicKey: "cHViLWtleQ",
      rpId: "chalito.chalyb.com",
    });
  });

  it("a passkey binding signed by another key is refused: nothing is trusted", async () => {
    const w = await world({ passkey: "forged" });
    expect(await runPair(w.deps(true))).toEqual({ ok: false, reason: "bad_claim" });
    expect(w.asked).toHaveLength(0);
    expect(existsSync(join(w.dir, "trusted-clients.json"))).toBe(false);
  });

  it("without a passkey the phone is still paired, and the user is told it can't approve HIGH", async () => {
    const w = await world({ passkey: "none" });
    expect((await runPair(w.deps(true))).ok).toBe(true);
    expect(w.out()).toMatch(/aún no tiene llave de acceso/);
    const id = await loadOrCreateIdentity(w.secrets);
    expect(
      (await new TrustStore(w.dir, id.sign, id.deviceId).load()).list.webauthnFor(w.phone.deviceId),
    ).toBeUndefined();
  });
});
