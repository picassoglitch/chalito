/**
 * Beta rehearsal: the beta's main paths, end to end across the apps, on the LOCAL Supabase stack
 * (the supabase CI job). Real api, real database and Auth, real Realtime; outside services
 * (hub, Twilio, Meta, OpenAI) mocked at the network. Each step is its own describe with its own
 * people and devices, so one failure doesn't hide the others.
 */
import { afterAll, describe, expect, it } from "vitest";
import { fingerprint, signEnvelope } from "@chalito/crypto";
import { READY, createStack, keys, type Person } from "./stack.js";

const stack = READY ? createStack() : null;
afterAll(async () => {
  await stack?.close();
});

describe.skipIf(!READY)("1. hub SSO launch → web session → first client device + passkey", () => {
  const s = stack!;
  let p: Person;

  it("the hub provisions the tenant and its SSO launch signs the person into the web, then the phone enrols", async () => {
    p = await s.person("ana");
    expect(p.userToken).toBeTruthy();
    // The phone is a device user under RLS: it sees its own device row, as a client.
    const { data, error } = await p.phone.db.from("devices").select("device_id, role, revoked").eq("owner", p.owner);
    expect(error).toBeNull();
    expect(data).toEqual([{ device_id: p.phone.deviceId, role: "client", revoked: false }]);
    expect(s.audit.events.some((e) => e.owner === p.owner)).toBe(true);
  });

  it("a second 'first' client is refused (new clients need an endorsement)", async () => {
    const other = await keys();
    const res = await s.call(
      "/v1/devices/first",
      {
        registration: await s.registration(p.owner, other, "phone", "Otro"),
        recoveryCode: "ABCDE-FGHJK-MNPQR-STVWX-YZ0123",
      },
      p.userToken,
    );
    expect(res.status).toBe(409);
  });

  it("the phone enrols a passkey; a step-up assertion is then available for it", async () => {
    await s.enrolPasskey(p);
    const opts = await s.call("/v1/webauthn/assert/options", {}, p.phone.token);
    expect(opts.status).toBe(200);
    expect(opts.json.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([p.passkey!.credentialId]);
    const assertion = await p.passkey!.get(opts.json.options);
    expect(assertion.id).toBe(p.passkey!.credentialId);
  });
});

describe.skipIf(!READY)("2. pair a desktop agent with the glyph", () => {
  const s = stack!;
  let p: Person;

  it("the agent's signed glyph is claimed by the phone; the agent signs in as its own device", async () => {
    p = await s.person("beto");
    const { device: agent } = await s.pairAgent(p, "Laptop de Beto");
    // The agent reads under RLS as itself: both devices of the account, roles intact.
    const { data, error } = await agent.db.from("devices").select("device_id, role").eq("owner", p.owner);
    expect(error).toBeNull();
    expect(new Map((data ?? []).map((d) => [d.device_id, d.role]))).toEqual(
      new Map([
        [p.phone.deviceId, "client"],
        [agent.deviceId, "agent"],
      ]),
    );
  });

  it("a glyph can't be published twice, and a claim for a fingerprint the user didn't see is refused", async () => {
    const { glyph, device: agent } = await s.pairAgent(p, "Laptop 2");
    expect((await s.call("/v1/pairing/codes", { glyph, kind: "laptop", platform: "linux" })).status).toBe(409);
    const other = await keys();
    const { signGlyph } = await import("@chalito/glyph");
    const g = await signGlyph(
      { ...glyph.body, codeId: `code_x${Date.now()}`, issuerPubSign: other.pubSign, issuerPubBox: other.pubBox },
      other.sign.secretKey,
    );
    expect((await s.call("/v1/pairing/codes", { glyph: g, kind: "laptop", platform: "linux" })).status).toBe(201);
    const claim = await signEnvelope(
      "chalito.pairing-claim.v1",
      {
        v: 1 as const,
        owner: p.owner,
        codeId: g.body.codeId,
        agentDeviceId: other.deviceId,
        agentFingerprint: await fingerprint(agent.sign.publicKey), // another device's fingerprint
        claimerDeviceId: p.phone.deviceId,
        issuedAt: s.now(),
      },
      p.phone.deviceId,
      p.phone.sign.secretKey,
    );
    expect((await s.call("/v1/pairing/claim", { claim }, p.phone.token)).json.error).toBe("fingerprint_mismatch");
  });
});
