import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TrustedClientList,
  deriveDeviceId,
  generateBoxKeyPair,
  generateSigningKeyPair,
  signDetached,
  signEnvelope,
  toB64url,
} from "@chalito/crypto";
import { syncEndorsements } from "../src/endorsement-sync.js";
import { MemoryStore, type EndorsementRow } from "../src/store.js";
import { TrustStore } from "../src/trust-store.js";

const NOW = 1_790_000_000_000;
const SELF = "agent_self";

const device = async () => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return {
    sign,
    deviceId: await deriveDeviceId(sign.publicKey),
    pubSign: await toB64url(sign.publicKey),
    pubBox: await toB64url(box.publicKey),
  };
};

const setup = async () => {
  const phone = await device();
  const desk = await device();
  const list = new TrustedClientList(SELF);
  await list.addConfirmed({ deviceId: phone.deviceId, pubSign: phone.pubSign, pubBox: phone.pubBox }, NOW);
  const endorse = (by = phone, over: Record<string, unknown> = {}) =>
    signEnvelope(
      "chalito.endorsement.v1",
      {
        v: 1,
        uid: "u1",
        newDeviceId: desk.deviceId,
        pubSign: desk.pubSign,
        pubBox: desk.pubBox,
        issuedAt: NOW,
        agents: [{ deviceId: SELF, pubSign: phone.pubSign, pubBox: phone.pubBox, fingerprint: "FP" }],
        ...over,
      },
      by.deviceId,
      by.sign.secretKey,
    );
  const store = new MemoryStore();
  const saveTrust = vi.fn(async () => undefined);
  const onAdded = vi.fn();
  const onRefused = vi.fn();
  const reported = new Set<string>();
  const run = () =>
    syncEndorsements({ store, trust: () => list, saveTrust, now: () => NOW, onAdded, onRefused, reported });
  const row = async (over: Partial<EndorsementRow> = {}): Promise<EndorsementRow> => ({
    deviceId: desk.deviceId,
    endorsement: await endorse(),
    revoked: false,
    webauthnBinding: null,
    ...over,
  });
  return { phone, desk, list, store, saveTrust, onAdded, onRefused, run, row, endorse };
};

describe("agent: endorsement sync (ADR 0018)", () => {
  it("adds a client endorsed by a locally trusted client that names this agent, once", async () => {
    const s = await setup();
    s.store.endorsements.push(await s.row());
    expect(await s.run()).toEqual([s.desk.deviceId]);
    expect(s.list.has(s.desk.deviceId)).toBe(true);
    expect(s.onAdded).toHaveBeenCalledWith(s.desk.deviceId, s.phone.deviceId);
    expect(s.saveTrust).toHaveBeenCalledTimes(1);
    expect(await s.run()).toEqual([]);
    expect(s.saveTrust).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["revoked in the directory", async (s: Awaited<ReturnType<typeof setup>>) => s.row({ revoked: true })],
    [
      "signed by a client this agent doesn't trust",
      async (s: Awaited<ReturnType<typeof setup>>) => s.row({ endorsement: await s.endorse(await device()) }),
    ],
    [
      "for another agent only",
      async (s: Awaited<ReturnType<typeof setup>>) =>
        s.row({
          endorsement: await s.endorse(undefined, {
            agents: [{ deviceId: "agent_other", pubSign: s.phone.pubSign, pubBox: s.phone.pubBox, fingerprint: "FP" }],
          }),
        }),
    ],
    [
      "filed under another device id",
      async (s: Awaited<ReturnType<typeof setup>>) => s.row({ deviceId: "dev_swapped" }),
    ],
    ["malformed", async (s: Awaited<ReturnType<typeof setup>>) => s.row({ endorsement: { nope: true } })],
    [
      "with a malformed passkey binding",
      async (s: Awaited<ReturnType<typeof setup>>) => s.row({ webauthnBinding: { nope: true } }),
    ],
    [
      "older than 7 days",
      async (s: Awaited<ReturnType<typeof setup>>) =>
        s.row({ endorsement: await s.endorse(undefined, { issuedAt: NOW - 8 * 86_400_000 }) }),
    ],
  ])("ignores an endorsement %s", async (_n, make) => {
    const s = await setup();
    s.store.endorsements.push(await make(s));
    expect(await s.run()).toEqual([]);
    expect(s.list.toJSON()).toHaveLength(1);
    expect(s.saveTrust).not.toHaveBeenCalled();
  });

  it("a client removed on this agent never comes back through its stored endorsement", async () => {
    const s = await setup();
    s.store.endorsements.push(await s.row());
    await s.run();
    s.list.remove(s.desk.deviceId);
    expect(await s.run()).toEqual([]);
    expect(s.list.has(s.desk.deviceId)).toBe(false);
  });

  it("the store's pointer hook drives it", async () => {
    const s = await setup();
    const added: string[] = [];
    s.store.watchEndorsements(() => void s.run().then((ids) => added.push(...ids)));
    s.store.pushEndorsement(await s.row());
    await vi.waitFor(() => expect(added).toEqual([s.desk.deviceId]));
  });
});

describe("refusals are never silent (R-L13)", () => {
  it("reports a refusal the person must act on once per client and reason; the endorser's choice stays quiet", async () => {
    const s = await setup();
    s.store.endorsements.push(await s.row({ endorsement: await s.endorse(await device()) }));
    await s.run();
    await s.run();
    expect(s.onRefused).toHaveBeenCalledTimes(1);
    expect(s.onRefused).toHaveBeenCalledWith(s.desk.deviceId, expect.any(String), "bad_signature");
    const s2 = await setup();
    s2.store.endorsements.push(
      await s2.row({
        endorsement: await s2.endorse(undefined, {
          agents: [{ deviceId: "agent_other", pubSign: s2.phone.pubSign, pubBox: s2.phone.pubBox, fingerprint: "FP" }],
        }),
      }),
    );
    await s2.run();
    expect(s2.onRefused).not.toHaveBeenCalled();
  });
});

describe("trusted-clients.json with tombstones", () => {
  it("persists tombstones under the same signature; old files without them still verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-trust-"));
    const keys = await generateSigningKeyPair();
    const store = new TrustStore(dir, keys, SELF);
    const phone = await device();
    const list = new TrustedClientList(SELF);
    await list.addConfirmed({ deviceId: phone.deviceId, pubSign: phone.pubSign, pubBox: phone.pubBox }, NOW);

    // Old format: no `removed` key, signature over {deviceId, clients}.
    await store.save(list);
    expect(JSON.parse(readFileSync(store.file, "utf8")).removed).toBeUndefined();
    expect((await store.load()).tampered).toBe(false);

    list.remove("dev_revoked");
    await store.save(list);
    const loaded = await store.load();
    expect(loaded.tampered).toBe(false);
    expect(loaded.list.removedIds()).toEqual(["dev_revoked"]);

    // Dropping a tombstone from the file breaks the signature.
    const f = JSON.parse(readFileSync(store.file, "utf8"));
    writeFileSync(store.file, JSON.stringify({ ...f, removed: [] }));
    expect((await store.load()).tampered).toBe(true);
    // And a file signed the old way can't smuggle in tombstone changes either.
    const sig = await signDetached("chalito.trusted-list.v1", { deviceId: SELF, clients: f.clients }, keys.secretKey);
    writeFileSync(store.file, JSON.stringify({ clients: f.clients, removed: ["x"], sig }));
    expect((await store.load()).tampered).toBe(true);
  });
});
