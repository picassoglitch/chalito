/**
 * Pairing from the desktop panel (ADR 0028 §3): the same ceremony as `chalito pair`, answered by
 * the panel over IPC. Nothing is trusted before the local "Sí, fui yo"; "No" (at the reverse
 * check, or while waiting) writes nothing.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveDeviceId,
  fingerprint,
  generateBoxKeyPair,
  generateSigningKeyPair,
  toB64url,
  verifyEnvelope,
} from "@chalito/crypto";
import type { GlyphPayload, PairingCodeDoc } from "@chalito/protocol";
import type { FetchFn, PairingWatcher } from "../src/cloud.js";
import { configPath, readConfig } from "../src/config.js";
import { IpcError, startIpcServer } from "../src/ipc-server.js";
import { PanelPairing, pairingHandlers, runPairingHost, type PairingView } from "../src/pairing-host.js";
import { MemorySecretStore } from "../src/secrets.js";
import { TrustStore } from "../src/trust-store.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { ipcHandlers } from "../src/ipc-handlers.js";

const NOW = 1_790_000_000_000;

const world = async (opts: { owner?: string } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "chalito-panel-pair-"));
  writeFileSync(
    configPath(dir),
    JSON.stringify({ apiBase: "https://api.test", supabase: { url: "http://127.0.0.1:54321", publishableKey: "k" } }),
  );
  const sign = await generateSigningKeyPair();
  const phone = {
    deviceId: await deriveDeviceId(sign.publicKey),
    pubSign: await toB64url(sign.publicKey),
    pubBox: await toB64url((await generateBoxKeyPair()).publicKey),
    fingerprint: await fingerprint(sign.publicKey),
  };
  let glyph: GlyphPayload | null = null;
  const fetch: FetchFn = async (url, init) => {
    if (url.endsWith("/v1/pairing/withdraw")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    glyph = (JSON.parse(init.body) as { glyph: GlyphPayload }).glyph;
    return {
      ok: true,
      status: 201,
      json: async () => ({ shortCode: "7K3M-QX9P", watchToken: "w", expiresAt: NOW + 300_000 }),
    };
  };
  let push: ((d: Partial<PairingCodeDoc>) => Promise<void>) | null = null;
  const stopped: boolean[] = [];
  const watcher: PairingWatcher = {
    watch: async (_t, codeId, onDoc) => {
      const g = glyph!;
      const base: PairingCodeDoc = {
        v: 1,
        codeId,
        shortCodeHash: "0".repeat(64),
        glyph: g,
        agentDeviceId: await deriveDeviceId(Buffer.from(g.body.issuerPubSign, "base64url")),
        kind: "desktop",
        platform: "macos",
        claimed: false,
        owner: null,
        claimedByDeviceId: null,
        claimerPubSign: null,
        claimerPubBox: null,
        claimerWebauthnBinding: null,
        cancelled: false,
        expiresAt: g.body.expiresAt,
      };
      push = async (d) => onDoc({ ...base, ...d });
      const i = stopped.push(false) - 1;
      return async () => void (stopped[i] = true);
    },
  };
  const claim = () =>
    push!({
      claimed: true,
      owner: opts.owner ?? "hub-user-1",
      claimedByDeviceId: phone.deviceId,
      claimerPubSign: phone.pubSign,
      claimerPubBox: phone.pubBox,
    });
  const secrets = new MemorySecretStore();
  const pairing = new PanelPairing({
    dir,
    env: {},
    secrets,
    fetch,
    watcher,
    osAuth: { verify: async () => true },
    now: () => NOW,
    hostname: "MacBook de Ana",
    platform: "darwin",
  });
  return {
    dir,
    phone,
    secrets,
    pairing,
    claim,
    decline: () => push!({ cancelled: true }),
    stopped,
    codeId: () => glyph!.body.codeId,
  };
};

/** Waits until the pairing reaches `state`. */
const until = async (p: PanelPairing, state: PairingView["state"]) => {
  for (let i = 0; i < 200; i++) {
    if (p.view()?.state === state) return p.view()!;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never reached ${state}, at ${p.view()?.state}`);
};

describe("pairing from the desktop panel", () => {
  it("shows this computer and the approval link, then trusts the approver only after Sí, fui yo", async () => {
    const w = await world();
    const started = w.pairing.start("laptop");
    expect(started.state).toBe("starting");
    const waiting = await until(w.pairing, "waiting");
    const id = await loadOrCreateIdentity(w.secrets);
    expect(waiting.computer).toMatchObject({
      shortCode: "7K3M-QX9P",
      fingerprint: id.fingerprint,
      label: "MacBook de Ana",
      approveUrl: expect.stringMatching(/^https:\/\/www\.chalyb\.com\/app\/chalito\/computadoras\/aprobar#c=/),
    });
    expect(waiting.computer!.approveUrl).not.toContain("7K3M");
    expect(w.pairing.start().pairingId).toBe(started.pairingId); // one at a time

    await w.claim();
    const claimed = await until(w.pairing, "claimed");
    expect(claimed.claimer).toEqual({ fingerprint: w.phone.fingerprint, passkeyId: null });
    expect(readConfig(w.dir, {}).owner).toBeNull(); // nothing yet

    w.pairing.confirm(started.pairingId, true);
    await until(w.pairing, "paired");
    await w.pairing.done;
    expect(readConfig(w.dir, {})).toMatchObject({ owner: "hub-user-1", deviceId: id.deviceId });
    const trust = await new TrustStore(w.dir, id.sign, id.deviceId).load();
    expect(trust.list.toJSON()).toMatchObject([{ deviceId: w.phone.deviceId, via: "local_confirmation" }]);
  });

  it("No at the reverse check writes nothing", async () => {
    const w = await world();
    const { pairingId } = w.pairing.start();
    await until(w.pairing, "waiting");
    await w.claim();
    await until(w.pairing, "claimed");
    w.pairing.confirm(pairingId, false);
    await until(w.pairing, "rejected");
    expect(readConfig(w.dir, {}).owner).toBeNull();
    expect(existsSync(join(w.dir, "trusted-clients.json"))).toBe(false);
  });

  it("Cancelar while waiting stops the wait; a new start makes a new code", async () => {
    const w = await world();
    const first = w.pairing.start();
    await until(w.pairing, "waiting");
    w.pairing.confirm(first.pairingId, false);
    await until(w.pairing, "cancelled");
    expect(w.stopped[0]).toBe(true);
    const second = w.pairing.start();
    expect(second.pairingId).not.toBe(first.pairingId);
  });

  it("a code declined from the browser shows as declined", async () => {
    const w = await world();
    w.pairing.start();
    await until(w.pairing, "waiting");
    await w.decline();
    await until(w.pairing, "declined");
    expect(readConfig(w.dir, {}).owner).toBeNull();
  });

  it("loopback proof: only for the waiting code, signed with the key published at /codes", async () => {
    const w = await world();
    const nonce = "N".repeat(43);
    expect(await w.pairing.proveLoopback("abcdefghijklmnopqrstuv", nonce, "https://www.chalyb.com")).toBeNull();
    w.pairing.start();
    const waiting = await until(w.pairing, "waiting");
    const codeId = w.codeId();
    expect(await w.pairing.proveLoopback("another_code_id_012345", nonce, "https://www.chalyb.com")).toBeNull();
    const proof = (await w.pairing.proveLoopback(codeId, nonce, "https://www.chalyb.com")) as Parameters<
      typeof verifyEnvelope
    >[0] & { body: Record<string, unknown> };
    const id = await loadOrCreateIdentity(w.secrets);
    expect(proof.body).toMatchObject({ v: 1, codeId, nonce, origin: "https://www.chalyb.com" });
    expect(
      (await verifyEnvelope(proof, "chalito.pairing-loopback.v1", new Map([[id.deviceId, id.sign.publicKey]]))).ok,
    ).toBe(true);
    expect(waiting.computer!.approveUrl).toContain(codeId);
    // Once claimed, nothing more to prove.
    await w.claim();
    await until(w.pairing, "claimed");
    expect(await w.pairing.proveLoopback(codeId, nonce, "https://www.chalyb.com")).toBeNull();
  });

  it("answers for another or a finished pairing are refused", async () => {
    const w = await world();
    const { pairingId } = w.pairing.start();
    await until(w.pairing, "waiting");
    expect(() => w.pairing.confirm("pair_other", true)).toThrow(IpcError);
    expect(() => w.pairing.confirm(pairingId, true)).toThrow("no_pending_pairing"); // yes before any claim
  });

  it("the IPC calls: startPairing, pendingPairing, confirmPairing, behind the panel's secret", async () => {
    const w = await world();
    const secret = "ab".repeat(16);
    const path = join(w.dir, "agent.sock");
    const server = await startIpcServer({ path, secret, handlers: pairingHandlers(w.pairing) });
    const { createConnection } = await import("node:net");
    const call = (method: string, params?: unknown, token = secret) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const sock = createConnection(path);
        sock.once(
          "data",
          (b) => (resolve(JSON.parse(String(b).split("\n")[0]!) as Record<string, unknown>), sock.end()),
        );
        sock.write(`${JSON.stringify({ id: 1, token, method, params })}\n`);
      });
    try {
      expect(await call("pendingPairing", undefined, "cd".repeat(16))).toMatchObject({
        ok: false,
        error: "unauthorized",
      });
      expect(await call("pendingPairing")).toMatchObject({ ok: true, result: null });
      const started = (await call("startPairing", { kind: "laptop" })).result as PairingView;
      expect(started.state).toBe("starting");
      await until(w.pairing, "waiting");
      expect(((await call("pendingPairing")).result as PairingView).state).toBe("waiting");
      expect(await call("confirmPairing", { pairingId: started.pairingId, match: "yes" })).toMatchObject({
        ok: false,
        error: "bad_params",
      });
      expect(await call("ping")).toMatchObject({ ok: true, result: { paired: false } });
    } finally {
      await server.close();
    }
  });

  it("the host exits when this computer gets paired another way (chalito pair in a terminal)", async () => {
    const w = await world();
    let released = false;
    const done = runPairingHost({
      dir: w.dir,
      secret: "ef".repeat(16),
      pair: {
        dir: w.dir,
        env: {},
        secrets: w.secrets,
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        osAuth: { verify: async () => true },
      },
      lock: () => () => void (released = true),
      pollMs: 10,
    });
    writeFileSync(
      configPath(w.dir),
      JSON.stringify({
        apiBase: "https://api.test",
        supabase: { url: "http://127.0.0.1:54321", publishableKey: "k" },
        owner: "hub-user-1",
        deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA",
      }),
    );
    await done;
    expect(released).toBe(true);
  }, 10_000);

  it("once paired, the daemon has no pairing to start", async () => {
    const handlers = ipcHandlers({} as never);
    await expect(handlers.startPairing!({})).rejects.toThrow("already_paired");
    expect(await handlers.pendingPairing!({})).toBeNull();
  });
});
