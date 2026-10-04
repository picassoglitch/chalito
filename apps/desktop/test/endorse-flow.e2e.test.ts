// @vitest-environment node
/**
 * End to end, in process: the desktop panel becomes a trusted client through the real api
 * routes (/v1/endorse + /v1/devices/endorsed), the real client channel and the trusted
 * phone's client-keys flows. Only storage (an in-memory ApiRepo) and Realtime (the repo fires
 * the pointer when an endorsement lands, like the migration's trigger) are stand-ins.
 */
import { describe, expect, it } from "vitest";
import { endorsementChannel, type EndorseDisplay } from "@chalito/client";
import {
  DeviceClientKeys,
  EndorseError,
  approveEndorsement,
  endorseGlyph,
  generateDeviceKeys,
  httpApi,
  publicKeys,
  resolveForEndorsement,
  type DeviceKeys,
} from "@chalito/client-keys";
import { fingerprint, randomNonce } from "@chalito/crypto";
import { signGlyph } from "@chalito/glyph";
import type { IntroducedAgent } from "@chalito/protocol";
import type { DeviceDoc } from "@chalito/protocol";
import { createApp } from "../../api/src/app.js";
import { MemoryAudit, type Deps } from "../../api/src/deps.js";
import type { ApiRepo, EndorseCodeRecord } from "../../api/src/repo.js";
import { enrollDesktop } from "../src/lib/enrollment.js";

const OWNER = "8a7a0d3c-5b5e-4a39-9d2b-2f8b1e0c4a11";

const world = async () => {
  const phoneKeys = await generateDeviceKeys();
  const pub = await publicKeys(phoneKeys);
  const devices: DeviceDoc[] = [
    {
      v: 1,
      deviceId: phoneKeys.deviceId,
      owner: OWNER,
      kind: "phone",
      platform: "android",
      name: "Teléfono",
      role: "client",
      pubSign: pub.pubSign,
      pubBox: pub.pubBox,
      fingerprint: await fingerprint(phoneKeys.sign.publicKey),
      enrolledVia: "first_client",
      endorsedBy: null,
      revoked: false,
      revokedAt: null,
      createdAt: Date.now(),
      lastSeenAt: null,
      policyHash: null,
      devMode: { on: false, toggles: [], since: null },
    } satisfies DeviceDoc,
  ];
  const codes = new Map<string, EndorseCodeRecord>();
  const pointers = new Map<string, () => void>();
  const saved: { newDeviceId: string; endorsement: unknown }[] = [];
  const repo: Partial<ApiRepo> = {
    getDevice: async (o, id) => devices.find((d) => d.owner === o && d.deviceId === id) ?? null,
    createDevice: async (_o, doc) =>
      devices.some((d) => d.deviceId === doc.deviceId) ? "exists" : (devices.push(doc), "created"),
    saveEndorsement: async (_o, newDeviceId, endorsement) => void saved.push({ newDeviceId, endorsement }),
    getDeviceWebAuthn: async () => null,
    createEndorseCode: async (r) => {
      codes.set(r.codeId, {
        ...r,
        newDeviceId: r.registration.body.deviceId,
        endorsement: null,
        endorsedByDeviceId: null,
        endorsedAt: null,
        takenAt: null,
      });
      return "created";
    },
    findEndorseCode: async (id) => codes.get(id) ?? null,
    findEndorseCodeByShortHash: async (h) => [...codes.values()].find((c) => c.shortCodeHash === h) ?? null,
    approveEndorseCode: async (id, o, e, now) => {
      const c = codes.get(id);
      if (!c || c.owner !== o) return "not_found";
      if (c.endorsement) return "already_endorsed";
      if (c.expiresAt <= now) return "expired";
      codes.set(id, { ...c, ...e });
      queueMicrotask(() => pointers.get(id)?.()); // the migration's broadcast trigger
      return "ok";
    },
    takeEndorsement: async (id, o, now) => {
      const c = codes.get(id);
      if (!c || c.owner !== o) return { ok: false, reason: "not_found" };
      if (c.takenAt) return { ok: false, reason: "already_taken" };
      if (c.expiresAt <= now) return { ok: false, reason: "expired" };
      if (!c.endorsement) return { ok: false, reason: "not_endorsed" };
      codes.set(id, { ...c, takenAt: now });
      return { ok: true, endorsement: c.endorsement };
    },
  };
  const tokens: Record<string, { uid: string; role: string; owner: string; deviceId?: string }> = {
    person: { uid: OWNER, role: "user", owner: OWNER },
    phone: { uid: `d_${phoneKeys.deviceId}`, role: "client", owner: OWNER, deviceId: phoneKeys.deviceId },
  };
  const deps: Deps = {
    repo: repo as ApiRepo,
    identity: {
      verify: async (t: string) => {
        if (!tokens[t]) throw new Error("bad token");
        return tokens[t];
      },
      mintPairingWatch: async (codeId: string) => `watch-${codeId}`,
      releasePairingWatch: async () => undefined,
      mintDevice: async (_o: string, id: string) => `device-hash-${id}`,
    } as unknown as Deps["identity"],
    audit: new MemoryAudit(),
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: Date.now,
  };
  const app = createApp(deps);
  const api = (token: string) =>
    httpApi({
      baseUrl: "http://api.test",
      token: async () => token,
      fetch: ((input: URL | string, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
    });
  return { app, devices, saved, codes, pointers, phoneKeys, api, audit: deps.audit as MemoryAudit };
};

const desktopRun = async (
  w: Awaited<ReturnType<typeof world>>,
  desktopKeys: DeviceKeys,
  onDisplay: (d: EndorseDisplay) => void,
  trusted?: DeviceClientKeys,
) =>
  enrollDesktop({
    owner: OWNER,
    name: "Chalito (desktop)",
    keys: { load: async () => desktopKeys, save: async () => undefined },
    channel: endorsementChannel({
      api: w.api("person"),
      watch: async (codeId, _token, onPointer) => {
        w.pointers.set(codeId, onPointer);
        return () => w.pointers.delete(codeId);
      },
      glyphFor: (c) => endorseGlyph(desktopKeys, c, { label: "Chalito (desktop)", now: Date.now() }),
      pollMs: 60_000,
    }),
    userApi: w.api("person"),
    deviceApi: async () => w.api("person"),
    signer: (k) => DeviceClientKeys.create(k),
    platformAuthenticator: async () => false,
    ...(trusted
      ? {
          introduce: {
            // The devices directory as the api's repo holds it (cloud data).
            directory: async () =>
              w.devices.map((d) => ({
                deviceId: d.deviceId,
                role: d.role,
                revoked: d.revoked,
                pubSign: d.pubSign,
                pubBox: d.pubBox,
              })),
            trust: async (_k: DeviceKeys, agents: IntroducedAgent[], by: string) =>
              trusted.trustIntroducedAgents(agents, by, Date.now()),
          },
        }
      : {}),
    onDisplay: (d) => onDisplay(d as EndorseDisplay),
  });

describe("desktop endorsement, end to end", () => {
  it("glyph scan → fingerprint check → phone approves → the panel is an endorsed client", async () => {
    const w = await world();
    const desktopKeys = await generateDeviceKeys();
    const phone = await DeviceClientKeys.create(w.phoneKeys);
    let shownFingerprint = "";
    const r = await desktopRun(w, desktopKeys, (d) => {
      void (async () => {
        // The phone scans the glyph, shows the fingerprint, the person approves.
        const target = await resolveForEndorsement(w.api("phone"), { glyph: d.glyph }, Date.now());
        shownFingerprint = target.display.fingerprint;
        await approveEndorsement(w.api("phone"), phone, target, { uid: OWNER, now: Date.now() });
      })();
    });
    expect(r).toMatchObject({
      ok: true,
      deviceId: desktopKeys.deviceId,
      customToken: `device-hash-${desktopKeys.deviceId}`,
    });
    expect(shownFingerprint).toBe(await fingerprint(desktopKeys.sign.publicKey));
    const created = w.devices.find((d) => d.deviceId === desktopKeys.deviceId)!;
    expect(created).toMatchObject({
      role: "client",
      kind: "web",
      enrolledVia: "endorsement",
      endorsedBy: w.phoneKeys.deviceId,
    });
    expect(w.saved).toHaveLength(1);
    expect(w.audit.events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["endorse.code_created", "endorse.approved", "device.enrolled"]),
    );
  });

  it("the typed short code works too", async () => {
    const w = await world();
    const desktopKeys = await generateDeviceKeys();
    const phone = await DeviceClientKeys.create(w.phoneKeys);
    const r = await desktopRun(w, desktopKeys, (d) => {
      void (async () => {
        const target = await resolveForEndorsement(w.api("phone"), { shortCode: d.shortCode }, Date.now());
        await approveEndorsement(w.api("phone"), phone, target, { uid: OWNER, now: Date.now() });
      })();
    });
    expect(r.ok).toBe(true);
  });

  it("a glyph re-signed by another key is refused before anything is signed", async () => {
    const w = await world();
    const desktopKeys = await generateDeviceKeys();
    const attacker = await generateDeviceKeys();
    let refusal: unknown = null;
    const run = desktopRun(w, desktopKeys, (d) => {
      void (async () => {
        // Same code, but the glyph's key isn't the registered one (a swapped QR on screen).
        const forged = await endorseGlyph(
          attacker,
          { codeId: d.codeId, expiresAt: d.expiresAt },
          { label: "x", now: Date.now() },
        );
        refusal = await resolveForEndorsement(w.api("phone"), { glyph: forged }, Date.now()).catch((e: unknown) => e);
        // Nothing approved: give up so the test ends.
        w.codes.set(d.codeId, { ...w.codes.get(d.codeId)!, expiresAt: 0 });
        w.pointers.get(d.codeId)?.();
      })();
    });
    const r = await run;
    expect(refusal).toBeInstanceOf(EndorseError);
    expect((refusal as EndorseError).code).toBe("key_mismatch");
    expect(r.ok).toBe(false);
    expect(w.devices.some((d) => d.deviceId === desktopKeys.deviceId)).toBe(false);
  });

  describe("ADR 0018: the endorsement introduces the phone's computers", () => {
    /** The phone confirmed `laptop` by glyph; the directory holds `laptop` (maybe swapped). */
    const withLaptop = async (swapBox: boolean) => {
      const w = await world();
      const laptop = await generateDeviceKeys();
      const lpub = await publicKeys(laptop);
      const phone = await DeviceClientKeys.create(w.phoneKeys);
      const glyph = await signGlyph(
        {
          v: 1,
          purpose: "pair_device",
          codeId: "code_laptop01",
          issuerPubSign: lpub.pubSign,
          issuerPubBox: lpub.pubBox,
          label: "Laptop",
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          nonce: await randomNonce(),
        },
        laptop.sign.secretKey,
      );
      await phone.trustAgentFromGlyph(glyph, await fingerprint(laptop.sign.publicKey), Date.now());
      const swapped = swapBox ? (await publicKeys(await generateDeviceKeys())).pubBox : lpub.pubBox;
      w.devices.push({
        ...w.devices[0]!,
        deviceId: laptop.deviceId,
        role: "agent",
        kind: "laptop",
        platform: "linux",
        name: "Laptop",
        pubSign: lpub.pubSign,
        pubBox: swapped,
        fingerprint: await fingerprint(laptop.sign.publicKey),
        enrolledVia: "pairing",
      });
      const desktopKeys = await generateDeviceKeys();
      const desktop = await DeviceClientKeys.create(desktopKeys);
      const r = await desktopRun(
        w,
        desktopKeys,
        (d) => {
          void (async () => {
            const target = await resolveForEndorsement(w.api("phone"), { glyph: d.glyph }, Date.now());
            await approveEndorsement(w.api("phone"), phone, target, {
              uid: OWNER,
              now: Date.now(),
              agents: phone.trustedAgents(),
            });
          })();
        },
        desktop,
      );
      return { r, desktop, laptop, lpub };
    };

    it("the new desktop can seal to the laptop its phone trusts, with no second pairing", async () => {
      const { r, desktop, laptop, lpub } = await withLaptop(false);
      expect(r).toMatchObject({ ok: true, agents: [laptop.deviceId], droppedAgents: [] });
      expect(desktop.trustedAgentBoxKey(laptop.deviceId)).toBe(lpub.pubBox);
      expect(desktop.trustedAgents()[0]).toMatchObject({ via: "endorsement" });
    });

    it("a server-side key swap for the laptop gets nothing trusted (the enrolment itself still works)", async () => {
      const { r, desktop, laptop } = await withLaptop(true);
      expect(r).toMatchObject({
        ok: true,
        agents: [],
        droppedAgents: [{ deviceId: laptop.deviceId, reason: "key_mismatch" }],
      });
      expect(desktop.trustedAgentBoxKey(laptop.deviceId)).toBeNull();
    });
  });
});
