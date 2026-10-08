import { describe, expect, it } from "vitest";
import type { ApiRepo } from "../../src/repo.js";
import {
  RACERS,
  agentFor,
  count,
  device,
  endorseCode,
  endorsementFor,
  owner,
  pairingCode,
  recovery,
} from "./fixtures.js";

/**
 * Behaviour every ApiRepo must have, whatever the backend. Each test uses fresh owners and
 * ids, so the suite can run against a shared database. Point it at a new implementation
 * with `runApiRepoContract("PostgresRepo", () => new PostgresRepo(pool))`.
 */
export interface ApiRepoContractOptions {
  /** Concurrent revokes: exactly one caller gets "revoked" (true for transactional backends). */
  strictRevoke?: boolean;
  /** The backend keeps a watcher per pairing code, released once by releasePairingWatches. */
  pairingWatches?: boolean;
}

/** A fresh owner whose user record exists (devices, recovery and notifications belong to a user). */
const seededOwner = async (repo: ApiRepo) => {
  const o = owner();
  await repo.upsertUserFromSso(o, { tenantId: o, email: "a@b.mx", tier: "pro", lastSsoAt: 1 });
  return o;
};

export const runApiRepoContract = (
  name: string,
  makeRepo: () => ApiRepo | Promise<ApiRepo>,
  opts: ApiRepoContractOptions = {},
) => {
  describe(`ApiRepo contract: ${name}`, () => {
    describe("tenants and users", () => {
      it("createTenant is created once, then exists", async () => {
        const repo = await makeRepo();
        const t = { tenantId: owner(), email: "a@b.mx", displayName: null, tier: "pro", createdAt: 1 };
        expect(await repo.createTenant(t)).toBe("created");
        expect(await repo.createTenant({ ...t, tier: "lite" })).toBe("exists");
      });

      it("setTenantStatus updates an existing tenant and reports a missing one", async () => {
        const repo = await makeRepo();
        const id = owner();
        expect(await repo.setTenantStatus(id, "paused", 2)).toBe(false);
        await repo.createTenant({ tenantId: id, email: "a@b.mx", displayName: "A", tier: "pro", createdAt: 1 });
        expect(await repo.setTenantStatus(id, "paused", 2)).toBe(true);
        expect(await repo.setTenantStatus(id, "active", 3)).toBe(true);
      });

      it("upsertUserFromSso creates or merges the user record", async () => {
        const repo = await makeRepo();
        const id = owner();
        await repo.upsertUserFromSso(id, { tenantId: id, email: "a@b.mx", tier: "pro", lastSsoAt: 1 });
        await repo.upsertUserFromSso(id, { tenantId: id, email: "a@b.mx", tier: "plus", lastSsoAt: 2 });
        expect(await repo.setTenantStatus(id, "active", 3)).toBe(true);
        expect(
          await repo.createTenant({ tenantId: id, email: "a@b.mx", displayName: null, tier: "pro", createdAt: 4 }),
        ).toBe("exists");
      });
    });

    describe("single-use markers (replay)", () => {
      it("claimSsoToken: first use wins, any reuse is a replay, and only one of N racers wins", async () => {
        const repo = await makeRepo();
        const h = `sso-${owner()}`;
        expect(await repo.claimSsoToken(h, Date.now() + 60_000)).toBe(true);
        expect(await repo.claimSsoToken(h, Date.now() + 60_000)).toBe(false);
        expect(await repo.claimSsoToken(`${h}-other`, Date.now() + 60_000)).toBe(true);
        const raced = `sso-race-${owner()}`;
        const results = await Promise.all(
          Array.from({ length: RACERS }, () => repo.claimSsoToken(raced, Date.now() + 60_000)),
        );
        expect(count(results, true)).toBe(1);
      });

      it("claimDeviceNonce: scoped per device, single use, and only one of N racers wins", async () => {
        const repo = await makeRepo();
        const n = `nonce-${owner()}`;
        expect(await repo.claimDeviceNonce("dev_a", n, Date.now() + 60_000)).toBe(true);
        expect(await repo.claimDeviceNonce("dev_a", n, Date.now() + 60_000)).toBe(false);
        expect(await repo.claimDeviceNonce("dev_b", n, Date.now() + 60_000)).toBe(true);
        const raced = `nonce-race-${owner()}`;
        const results = await Promise.all(
          Array.from({ length: RACERS }, () => repo.claimDeviceNonce("dev_a", raced, Date.now() + 60_000)),
        );
        expect(count(results, true)).toBe(1);
      });
    });

    describe("devices", () => {
      it("createDevice / getDevice round-trip; a taken id exists; owners are separate", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const d = await device(o);
        expect(await repo.getDevice(o, d.deviceId)).toBeNull();
        expect(await repo.createDevice(o, d)).toBe("created");
        expect(await repo.getDevice(o, d.deviceId)).toEqual(d);
        expect(await repo.createDevice(o, { ...d, name: "Otro" })).toBe("exists");
        expect((await repo.getDevice(o, d.deviceId))?.name).toBe(d.name);
        expect(await repo.getDevice(owner(), d.deviceId)).toBeNull();
      });

      it("touchDevice sets lastSeenAt", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const d = await device(o);
        await repo.createDevice(o, d);
        await repo.touchDevice(o, d.deviceId, 1_790_000_123_000);
        expect((await repo.getDevice(o, d.deviceId))?.lastSeenAt).toBe(1_790_000_123_000);
      });

      it("revokeDevice: not_found, then revoked once, then already_revoked (idempotent)", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const d = await device(o);
        expect(await repo.revokeDevice(o, d.deviceId, 5, "dev_x")).toBe("not_found");
        await repo.createDevice(o, d);
        expect(await repo.revokeDevice(o, d.deviceId, 5, "dev_x")).toBe("revoked");
        expect(await repo.revokeDevice(o, d.deviceId, 6, "dev_y")).toBe("already_revoked");
        expect(await repo.getDevice(o, d.deviceId)).toMatchObject({ revoked: true, revokedAt: 5 });
      });

      it("concurrent revokes all succeed (exactly one revoked when strict) and leave the device revoked", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const d = await device(o);
        await repo.createDevice(o, d);
        const results = await Promise.all(
          Array.from({ length: RACERS }, (_, i) => repo.revokeDevice(o, d.deviceId, 10 + i, null)),
        );
        if (opts.strictRevoke) expect(count(results, "revoked")).toBe(1);
        else expect(count(results, "revoked")).toBeGreaterThanOrEqual(1);
        expect(results.every((r) => r === "revoked" || r === "already_revoked")).toBe(true);
        expect((await repo.getDevice(o, d.deviceId))?.revoked).toBe(true);
      });

      it("saveEndorsement stores the endorsement; saving it again doesn't fail", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        await repo.saveEndorsement(o, "dev_new", { body: { newDeviceId: "dev_new" }, sig: "x" }, 1);
        await repo.saveEndorsement(o, "dev_new", { body: { newDeviceId: "dev_new" }, sig: "x" }, 2);
      });
    });

    describe("enrollFirstClient (atomic)", () => {
      it("enrolls only while no active client exists, and stores the recovery hash", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const a = await device(o);
        expect(await repo.enrollFirstClient(o, a, recovery(1))).toBe("ok");
        expect(await repo.getDevice(o, a.deviceId)).toEqual(a);
        expect(await repo.getRecovery(o)).toEqual(recovery(1));

        const b = await device(o);
        expect(await repo.enrollFirstClient(o, b, recovery(2))).toBe("client_exists");
        expect(await repo.getDevice(o, b.deviceId)).toBeNull();
        expect(await repo.getRecovery(o)).toEqual(recovery(1));

        await repo.revokeDevice(o, a.deviceId, 7, null);
        expect(await repo.enrollFirstClient(o, b, recovery(3))).toBe("ok");
        await repo.revokeDevice(o, b.deviceId, 8, null);
        expect(await repo.enrollFirstClient(o, { ...a, revoked: false }, recovery(4))).toBe("device_exists");
        expect(await repo.getRecovery(o)).toEqual(recovery(3));
      });

      it("an active agent blocks it too (agent_exists); a revoked one doesn't", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const agent = await device(o, "agent");
        await repo.createDevice(o, agent);
        const a = await device(o);
        expect(await repo.enrollFirstClient(o, a, recovery(1))).toBe("agent_exists");
        expect(await repo.getDevice(o, a.deviceId)).toBeNull();
        expect(await repo.getRecovery(o)).toBeNull();

        await repo.revokeDevice(o, agent.deviceId, 7, null);
        expect(await repo.enrollFirstClient(o, a, recovery(2))).toBe("ok");
        const b = await device(o);
        await repo.createDevice(o, await device(o, "agent"));
        expect(await repo.enrollFirstClient(o, b, recovery(3))).toBe("client_exists");
      });

      it(`exactly one of ${RACERS} concurrent first clients wins`, async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const racers = await Promise.all(Array.from({ length: RACERS }, () => device(o)));
        const results = await Promise.all(racers.map((d, i) => repo.enrollFirstClient(o, d, recovery(i))));
        expect(count(results, "ok")).toBe(1);
        expect(count(results, "client_exists")).toBe(RACERS - 1);
        const winner = racers[results.indexOf("ok")]!;
        expect(await repo.getRecovery(o)).toEqual(recovery(results.indexOf("ok")));
        for (const d of racers) expect(await repo.getDevice(o, d.deviceId)).toEqual(d === winner ? d : null);
      });
    });

    describe("recovery", () => {
      it("getRecovery is null until set; startRecovery records the cool-down", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        expect(await repo.getRecovery(o)).toBeNull();
        await repo.enrollFirstClient(o, await device(o), recovery(1));
        await repo.startRecovery(o, 9_000, 8_000);
        expect(await repo.getRecovery(o)).toMatchObject({ ...recovery(1), cooldownUntil: 9_000, startedAt: 8_000 });
      });

      it("completeRecovery creates the device and replaces the hash atomically", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        await repo.enrollFirstClient(o, await device(o), recovery(1));
        await repo.startRecovery(o, 9_000, 8_000);
        const d = await device(o, "client", { enrolledVia: "recovery" });
        expect(await repo.completeRecovery(o, d, recovery(2))).toBe("ok");
        expect(await repo.getDevice(o, d.deviceId)).toEqual(d);
        expect(await repo.getRecovery(o)).toEqual(recovery(2));
        // A taken id changes nothing, including the hash.
        expect(await repo.completeRecovery(o, d, recovery(3))).toBe("device_exists");
        expect(await repo.getRecovery(o)).toEqual(recovery(2));
      });

      it(`exactly one of ${RACERS} concurrent completions of the same device wins`, async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        await repo.enrollFirstClient(o, await device(o), recovery(1));
        const d = await device(o, "client", { enrolledVia: "recovery" });
        const results = await Promise.all(
          Array.from({ length: RACERS }, (_, i) => repo.completeRecovery(o, d, recovery(100 + i))),
        );
        expect(count(results, "ok")).toBe(1);
        expect(count(results, "device_exists")).toBe(RACERS - 1);
        expect(await repo.getRecovery(o)).toEqual(recovery(100 + results.indexOf("ok")));
      });

      it(`one recovery code completes once: ${RACERS} concurrent completions of different devices`, async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        await repo.enrollFirstClient(o, await device(o), recovery(1));
        const ds = await Promise.all(
          Array.from({ length: RACERS }, () => device(o, "client", { enrolledVia: "recovery" })),
        );
        const results = await Promise.all(
          ds.map((d, i) => repo.completeRecovery(o, d, recovery(200 + i), recovery(1).hash)),
        );
        expect(count(results, "ok")).toBe(1);
        expect(count(results, "code_changed")).toBe(RACERS - 1);
        const won = results.indexOf("ok");
        expect(await repo.getRecovery(o)).toEqual(recovery(200 + won));
        for (const [i, d] of ds.entries()) expect(await repo.getDevice(o, d.deviceId)).toEqual(i === won ? d : null);
      });

      it("enrollFirstClient answers no_user for an owner without a user record", async () => {
        const repo = await makeRepo();
        const o = owner();
        expect(await repo.enrollFirstClient(o, await device(o), recovery(1))).toBe("no_user");
        expect(await repo.getRecovery(o)).toBeNull();
      });
    });

    describe("notifications", () => {
      it("createNotification stores without error", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const n = {
          v: 1,
          nid: "recovery_1",
          uid: o,
          level: "L3",
          source: "security",
          urgency: "critical",
          counts: { approvals: 0, questions: 0, messages: 0, mesas: 0 },
          deepLink: "/",
          coalesceKey: "security:recovery",
          state: "pending",
          step: 0,
          nextAt: null,
          channels: ["desktop", "push", "whatsapp"],
          createdAt: 1_790_000_000_000,
          ackedAt: null,
          ackedVia: null,
        };
        await repo.createNotification(o, "recovery_1", n);
        await repo.createNotification(o, "recovery_1", { ...n, step: 1 });
      });
    });

    describe("WebAuthn (passkeys)", () => {
      it("a challenge is single-use, per device and purpose, and expires", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const d = await device(o);
        await repo.createDevice(o, d);
        const put = (purpose: "register" | "assert", challenge: string, expiresAt = 2_000) =>
          repo.putWebAuthnChallenge({ owner: o, deviceId: d.deviceId, purpose, challenge, expiresAt });
        await put("register", "c1");
        await put("register", "c2"); // replaces c1
        await put("assert", "a1");
        expect(await repo.takeWebAuthnChallenge(o, d.deviceId, "register", 1_000)).toBe("c2");
        expect(await repo.takeWebAuthnChallenge(o, d.deviceId, "register", 1_000)).toBeNull();
        expect(await repo.takeWebAuthnChallenge(o, d.deviceId, "assert", 3_000)).toBeNull(); // expired, and gone
        expect(await repo.takeWebAuthnChallenge(o, d.deviceId, "assert", 1_000)).toBeNull();
      });

      it("only one of N concurrent takers gets the challenge", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const d = await device(o);
        await repo.createDevice(o, d);
        await repo.putWebAuthnChallenge({
          owner: o,
          deviceId: d.deviceId,
          purpose: "register",
          challenge: "c",
          expiresAt: 2_000,
        });
        const got = await Promise.all(
          Array.from({ length: RACERS }, () => repo.takeWebAuthnChallenge(o, d.deviceId, "register", 1_000)),
        );
        expect(count(got, "c")).toBe(1);
      });

      it("stores the passkey on the device record", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const d = await device(o);
        const cred = {
          credentialId: `cred-${o}`,
          publicKey: "pQECAyYgASFYIA",
          rpId: "chalito.chalyb.com",
          counter: 0,
          transports: ["internal"],
          createdAt: 1_790_000_000_000,
        };
        expect(await repo.setDeviceWebAuthn(o, d.deviceId, cred)).toBe(false);
        await repo.createDevice(o, d);
        expect(await repo.getDeviceWebAuthn(o, d.deviceId)).toBeNull();
        expect(await repo.setDeviceWebAuthn(o, d.deviceId, cred)).toBe(true);
        expect(await repo.getDeviceWebAuthn(o, d.deviceId)).toEqual({ ...cred, binding: null });
        expect((await repo.getDevice(o, d.deviceId))?.revoked).toBe(false);
      });

      it("stores the device-signed binding with the passkey; a new passkey clears it", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const d = await device(o);
        await repo.createDevice(o, d);
        const binding = {
          ctx: "chalito.webauthn-binding.v1",
          body: { v: 1, deviceId: d.deviceId },
          signerDeviceId: d.deviceId,
          sig: "x",
        };
        expect(await repo.setDeviceWebAuthnBinding(o, d.deviceId, binding)).toBe(false); // no passkey yet
        const cred = {
          credentialId: `cred2-${o}`,
          publicKey: "pQECAyYgASFYIA",
          rpId: "chalito.chalyb.com",
          counter: 0,
          transports: [],
          createdAt: 1_790_000_000_000,
        };
        await repo.setDeviceWebAuthn(o, d.deviceId, cred);
        expect(await repo.setDeviceWebAuthnBinding(o, d.deviceId, binding)).toBe(true);
        expect((await repo.getDeviceWebAuthn(o, d.deviceId))?.binding).toEqual(binding);
        await repo.setDeviceWebAuthn(o, d.deviceId, { ...cred, credentialId: `cred3-${o}` });
        expect((await repo.getDeviceWebAuthn(o, d.deviceId))?.binding).toBeNull();
      });
    });

    describe("pairing codes", () => {
      it("createPairingCode once, then exists; found by short-code hash", async () => {
        const repo = await makeRepo();
        const code = await pairingCode();
        expect(await repo.findPairingCodeByShortHash(code.shortCodeHash)).toBeNull();
        expect(await repo.createPairingCode(code)).toBe("created");
        expect(await repo.createPairingCode(code)).toBe("exists");
        expect(await repo.findPairingCodeByShortHash(code.shortCodeHash)).toMatchObject(code);
      });

      it("claimPairingCode: not_found, then ok (device created, code claimed), then already_claimed", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const code = await pairingCode();
        const claim = {
          owner: o,
          claimedByDeviceId: "dev_phone",
          claimerPubSign: "ps",
          claimerPubBox: "pb",
          claimerWebauthnBinding: { ctx: "chalito.webauthn-binding.v1", sig: "s" },
          claimedAt: 42,
        };
        expect(await repo.claimPairingCode(code.codeId, claim, () => agentFor(code, o, "dev_phone"))).toEqual({
          ok: false,
          reason: "not_found",
        });
        await repo.createPairingCode(code);
        let seen: unknown;
        const agent = await agentFor(code, o, "dev_phone");
        const res = await repo.claimPairingCode(code.codeId, claim, async (c) => ((seen = c), agent));
        expect(res).toEqual({ ok: true, agentDeviceId: code.agentDeviceId });
        expect(seen).toMatchObject(code);
        expect(await repo.getDevice(o, code.agentDeviceId)).toEqual(agent);
        expect(await repo.findPairingCodeByShortHash(code.shortCodeHash)).toMatchObject({
          claimed: true,
          owner: o,
          claimedByDeviceId: "dev_phone",
          claimerPubSign: "ps",
          claimerPubBox: "pb",
          claimerWebauthnBinding: { ctx: "chalito.webauthn-binding.v1", sig: "s" },
        });
        expect(await repo.claimPairingCode(code.codeId, claim, async () => agent)).toEqual({
          ok: false,
          reason: "already_claimed",
        });
      });

      it("a throwing build aborts the claim and writes nothing", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const code = await pairingCode();
        await repo.createPairingCode(code);
        const claim = {
          owner: o,
          claimedByDeviceId: "dev_phone",
          claimerPubSign: "ps",
          claimerPubBox: "pb",
          claimedAt: 1,
        };
        await expect(
          repo.claimPairingCode(code.codeId, claim, async () => {
            throw new Error("fingerprint_mismatch");
          }),
        ).rejects.toThrow("fingerprint_mismatch");
        expect(await repo.getDevice(o, code.agentDeviceId)).toBeNull();
        expect((await repo.findPairingCodeByShortHash(code.shortCodeHash))?.claimed).toBe(false);
      });

      it("an existing agent device makes the claim device_exists and leaves the code unclaimed", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const code = await pairingCode();
        await repo.createPairingCode(code);
        const agent = await agentFor(code, o, "dev_phone");
        await repo.createDevice(o, agent);
        const claim = {
          owner: o,
          claimedByDeviceId: "dev_phone",
          claimerPubSign: "ps",
          claimerPubBox: "pb",
          claimedAt: 1,
        };
        expect(await repo.claimPairingCode(code.codeId, claim, async () => agent)).toEqual({
          ok: false,
          reason: "device_exists",
        });
        expect((await repo.findPairingCodeByShortHash(code.shortCodeHash))?.claimed).toBe(false);
      });

      it("agentLimitFor: a claim past the plan's computer cap is device_limit and writes nothing", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const first = await pairingCode();
        const second = await pairingCode();
        await repo.createPairingCode(first);
        await repo.createPairingCode(second);
        let seenTier: string | null | undefined;
        const claim = {
          owner: o,
          claimedByDeviceId: "dev_phone",
          claimerPubSign: "ps",
          claimerPubBox: "pb",
          claimedAt: 1,
          agentLimitFor: (tier: string | null) => ((seenTier = tier), 1),
        };
        expect(await repo.claimPairingCode(first.codeId, claim, () => agentFor(first, o, "dev_phone"))).toEqual({
          ok: true,
          agentDeviceId: first.agentDeviceId,
        });
        expect(seenTier).toBe("pro");
        expect(await repo.claimPairingCode(second.codeId, claim, () => agentFor(second, o, "dev_phone"))).toEqual({
          ok: false,
          reason: "device_limit",
          limit: 1,
        });
        expect(await repo.getDevice(o, second.agentDeviceId)).toBeNull();
        expect((await repo.findPairingCodeByShortHash(second.shortCodeHash))?.claimed).toBe(false);
        // A revoked computer frees its slot.
        await repo.revokeDevice(o, first.agentDeviceId, 2, null);
        expect(await repo.claimPairingCode(second.codeId, claim, () => agentFor(second, o, "dev_phone"))).toEqual({
          ok: true,
          agentDeviceId: second.agentDeviceId,
        });
      });

      it("releasePairingWatches hands each claimed code's watcher to its agent at most once", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const code = await pairingCode();
        await repo.createPairingCode(code);
        expect(await repo.releasePairingWatches(o, code.agentDeviceId)).toEqual([]); // not claimed yet
        const claim = {
          owner: o,
          claimedByDeviceId: "dev_phone",
          claimerPubSign: "ps",
          claimerPubBox: "pb",
          claimedAt: 1,
        };
        await repo.claimPairingCode(code.codeId, claim, () => agentFor(code, o, "dev_phone"));
        expect(await repo.releasePairingWatches(owner(), code.agentDeviceId)).toEqual([]); // other owner
        expect(await repo.releasePairingWatches(o, "dev_other")).toEqual([]); // other agent
        expect(await repo.releasePairingWatches(o, code.agentDeviceId)).toEqual(
          opts.pairingWatches ? [code.codeId] : [],
        );
        expect(await repo.releasePairingWatches(o, code.agentDeviceId)).toEqual([]);
      });

      it(`exactly one of ${RACERS} concurrent claims wins`, async () => {
        const repo = await makeRepo();
        const code = await pairingCode();
        await repo.createPairingCode(code);
        const owners = await Promise.all(Array.from({ length: RACERS }, () => seededOwner(repo)));
        const results = await Promise.all(
          owners.map(async (o) =>
            repo.claimPairingCode(
              code.codeId,
              { owner: o, claimedByDeviceId: "dev_phone", claimerPubSign: "ps", claimerPubBox: "pb", claimedAt: 1 },
              () => agentFor(code, o, "dev_phone"),
            ),
          ),
        );
        const reasons = results.map((r) => (r.ok ? "ok" : r.reason));
        expect(count(reasons, "ok")).toBe(1);
        expect(count(reasons, "already_claimed")).toBe(RACERS - 1);
        const winner = owners[reasons.indexOf("ok")]!;
        expect(await repo.findPairingCodeByShortHash(code.shortCodeHash)).toMatchObject({
          claimed: true,
          owner: winner,
        });
        for (const o of owners) {
          const d = await repo.getDevice(o, code.agentDeviceId);
          expect(d === null).toBe(o !== winner);
        }
      });
    });

    describe("passkey sign counter", () => {
      const withPasskey = async (repo: ApiRepo, counter = 0) => {
        const o = await seededOwner(repo);
        const d = await device(o);
        await repo.createDevice(o, d);
        const credentialId = `cred-${owner()}`;
        await repo.setDeviceWebAuthn(o, d.deviceId, {
          credentialId,
          publicKey: "pk",
          rpId: "chalito.chalyb.com",
          counter,
          transports: ["internal"],
          createdAt: 1,
        });
        return { o, d, credentialId };
      };

      it("moves forward only; a counter that doesn't advance is reported as cloned and not written", async () => {
        const repo = await makeRepo();
        const { o, d, credentialId } = await withPasskey(repo, 5);
        expect(await repo.bumpWebAuthnCounter(o, d.deviceId, credentialId, 6)).toBe("ok");
        expect(await repo.bumpWebAuthnCounter(o, d.deviceId, credentialId, 6)).toBe("cloned");
        expect(await repo.bumpWebAuthnCounter(o, d.deviceId, credentialId, 3)).toBe("cloned");
        expect(await repo.bumpWebAuthnCounter(o, d.deviceId, credentialId, 0)).toBe("cloned");
        expect((await repo.getDeviceWebAuthn(o, d.deviceId))?.counter).toBe(6);
        expect(await repo.bumpWebAuthnCounter(o, d.deviceId, "other-cred", 9)).toBe("not_found");
      });

      it("authenticators without a counter (always 0) are fine", async () => {
        const repo = await makeRepo();
        const { o, d, credentialId } = await withPasskey(repo, 0);
        expect(await repo.bumpWebAuthnCounter(o, d.deviceId, credentialId, 0)).toBe("ok");
        expect(await repo.bumpWebAuthnCounter(o, d.deviceId, credentialId, 0)).toBe("ok");
      });

      it(`of ${RACERS} concurrent assertions with the same counter, exactly one is accepted`, async () => {
        const repo = await makeRepo();
        const { o, d, credentialId } = await withPasskey(repo, 1);
        const results = await Promise.all(
          Array.from({ length: RACERS }, () => repo.bumpWebAuthnCounter(o, d.deviceId, credentialId, 2)),
        );
        expect(count(results, "ok")).toBe(1);
        expect(count(results, "cloned")).toBe(RACERS - 1);
      });
    });

    describe("endorsement handoff", () => {
      it("createEndorseCode: once per code id and per short code; found by either", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const code = await endorseCode(o);
        expect(await repo.createEndorseCode(code)).toBe("created");
        expect(await repo.createEndorseCode(code)).toBe("exists");
        expect(await repo.createEndorseCode({ ...(await endorseCode(o)), shortCodeHash: code.shortCodeHash })).toBe(
          "exists",
        );
        const found = await repo.findEndorseCode(code.codeId);
        expect(found).toMatchObject({
          codeId: code.codeId,
          owner: o,
          newDeviceId: code.registration.body.deviceId,
          registration: code.registration,
          endorsement: null,
          endorsedByDeviceId: null,
          takenAt: null,
          expiresAt: code.expiresAt,
        });
        expect(await repo.findEndorseCodeByShortHash(code.shortCodeHash)).toEqual(found);
        expect(await repo.findEndorseCode("nope_nope_nope_nope_00")).toBeNull();
      });

      it("approve: only the owner's live code, and exactly one of N concurrent approvals wins", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const other = await seededOwner(repo);
        const code = await endorseCode(o);
        await repo.createEndorseCode(code);
        const e = await endorsementFor(code, "dev_phone");
        const at = { endorsement: e, endorsedByDeviceId: "dev_phone", endorsedAt: Date.now() };
        expect(await repo.approveEndorseCode(code.codeId, other, at, Date.now())).toBe("not_found");
        expect(await repo.approveEndorseCode(code.codeId, o, at, code.expiresAt)).toBe("expired");
        const results = await Promise.all(
          Array.from({ length: RACERS }, () => repo.approveEndorseCode(code.codeId, o, at, Date.now())),
        );
        expect(count(results, "ok")).toBe(1);
        expect(count(results, "already_endorsed")).toBe(RACERS - 1);
        expect(await repo.findEndorseCode(code.codeId)).toMatchObject({
          endorsement: e,
          endorsedByDeviceId: "dev_phone",
        });
      });

      it("take: not before the endorsement, only the owner, exactly once among N racers, not after expiry", async () => {
        const repo = await makeRepo();
        const o = await seededOwner(repo);
        const code = await endorseCode(o);
        await repo.createEndorseCode(code);
        expect(await repo.takeEndorsement(code.codeId, o, Date.now())).toEqual({ ok: false, reason: "not_endorsed" });
        const e = await endorsementFor(code, "dev_phone");
        await repo.approveEndorseCode(
          code.codeId,
          o,
          { endorsement: e, endorsedByDeviceId: "dev_phone", endorsedAt: Date.now() },
          Date.now(),
        );
        expect(await repo.takeEndorsement(code.codeId, "someone-else", Date.now())).toEqual({
          ok: false,
          reason: "not_found",
        });
        expect(await repo.takeEndorsement(code.codeId, o, code.expiresAt)).toEqual({ ok: false, reason: "expired" });
        const results = await Promise.all(
          Array.from({ length: RACERS }, () => repo.takeEndorsement(code.codeId, o, Date.now())),
        );
        const oks = results.filter((r) => r.ok);
        expect(oks).toEqual([{ ok: true, endorsement: e }]);
        expect(results.filter((r) => !r.ok && r.reason === "already_taken")).toHaveLength(RACERS - 1);
        expect((await repo.findEndorseCode(code.codeId))?.takenAt).not.toBeNull();
      });
    });
  });
};
