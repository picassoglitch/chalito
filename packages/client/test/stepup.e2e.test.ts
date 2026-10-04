/**
 * HIGH approvals end to end with a real (software) passkey: the browser's ClientActions.decide
 * asks client-keys' passkeyStepUp for an assertion bound to the unsigned decision body (D-019),
 * signs the Decision, and the agent's own ApprovalManager verifies signature + assertion against
 * the passkey it learned at pairing.
 */
import { describe, expect, it } from "vitest";
import { MemoryNonceStore, TrustedClientList } from "@chalito/crypto";
// By path, not as a package dependency: @chalito/client-keys already depends on @chalito/client.
import { passkeyStepUp } from "../../client-keys/src/client.js";
import { SoftAuthenticator } from "../../client-keys/src/testing/soft-authenticator.js";
import type { Ceremonies } from "../../client-keys/src/webauthn.js";
import { ApprovalManager, type ApprovalOutcome } from "../../../apps/agent/src/approvals.js";
import { Sealer } from "../../../apps/agent/src/sealing.js";
import { MemoryStore } from "../../../apps/agent/src/store.js";
import { ActionError, ClientActions } from "../src/actions.js";
import type { StepUpProvider } from "../src/keys.js";
import { LiveStore } from "../src/live.js";
import { FakeSupabase, newDevice, testKeys, tick } from "./helpers.js";

const OWNER = "hub-user-1";
const RP_ID = "chalito.chalyb.com";

const setup = async (stepUp: (auth: SoftAuthenticator) => StepUpProvider, ttlMs = 2000) => {
  const agent = await newDevice();
  const browser = await newDevice();
  const auth = new SoftAuthenticator({ origin: `https://${RP_ID}` });

  // The agent's side: it confirmed this browser at pairing, including its passkey.
  const trust = new TrustedClientList(agent.deviceId);
  await trust.addConfirmed(
    { deviceId: browser.deviceId, pubSign: browser.pubSign, pubBox: browser.pubBox },
    Date.now(),
  );
  trust.setWebAuthn(browser.deviceId, { credentialId: auth.credentialId, publicKey: auth.publicKey, rpId: RP_ID });
  const agentStore = new MemoryStore();
  const audit: { type: string; [k: string]: unknown }[] = [];
  const approvals = new ApprovalManager({
    store: agentStore,
    trust: () => trust,
    nonces: new MemoryNonceStore(),
    sealer: new Sealer(() => trust, { deviceId: agent.deviceId, pubBox: agent.pubBox }),
    owner: OWNER,
    deviceId: agent.deviceId,
    signer: agent.sign,
    now: Date.now,
    ttlMs: () => ttlMs,
    audit: (e) => void audit.push(e),
  });

  // The browser's side.
  const db = new FakeSupabase();
  const keys = testKeys(browser, { [agent.deviceId]: agent.pubBox }, { [agent.deviceId]: agent.pubSign });
  const live = new LiveStore(db, keys, OWNER);
  const actions = new ClientActions(db, keys, live, { stepUp: stepUp(auth) });

  /** The agent asks; its row reaches the browser; the browser decides; the decision reaches the agent. */
  const run = async (allow: boolean): Promise<{ outcome: ApprovalOutcome; error?: unknown }> => {
    let error: unknown;
    const outcome = approvals.request({
      sid: "s1",
      risk: "HIGH",
      stepUp: true,
      origin: `client:${browser.deviceId}`,
      details: { toolName: "Bash", input: { command: "git push" }, reasons: ["push"] },
      onRequested: (aid) => {
        void (async () => {
          const req = agentStore.approvals.get(aid)!;
          db.seed("approvals", {
            owner: OWNER,
            aid,
            device_id: agent.deviceId,
            sid: req.sid,
            request_id: req.requestId,
            kind: req.kind,
            risk: req.risk,
            origin: req.origin,
            step_up_required: req.stepUpRequired,
            details_ct: req.detailsCt,
            status: "pending",
            created_at: new Date(req.createdAt).toISOString(),
            expires_at: new Date(req.expiresAt).toISOString(),
          });
          await live.resync();
          try {
            await actions.decide(aid, allow);
          } catch (err) {
            error = err;
            return;
          }
          const row = db.rows("approval_decisions").at(-1)!;
          agentStore.attachDecision(aid, row.decision);
        })();
      },
    });
    return { outcome: await outcome, error };
  };
  return { run, audit, db, live };
};

describe("HIGH approval: browser passkey step-up verified by the agent", () => {
  it("an allow with a passkey assertion bound to the decision is accepted", async () => {
    const t = await setup((auth) =>
      passkeyStepUp({ credentialId: auth.credentialId, rpId: RP_ID }, { ceremonies: auth as unknown as Ceremonies }),
    );
    const { outcome } = await t.run(true);
    expect(outcome).toMatchObject({ allow: true, reason: "signed_allow" });
    expect(t.audit).toEqual([]);
  });

  it("an assertion bound to anything else (not the decision body) is refused", async () => {
    const t = await setup(
      (auth) => async () => ({
        method: "webauthn" as const,
        at: Date.now(),
        // Signed over some other challenge: what a provider that ignores the body would produce.
        assertion: await auth.stepUp(RP_ID)(new Uint8Array(32).fill(7)),
      }),
      400,
    );
    const { outcome } = await t.run(true);
    expect(outcome).toMatchObject({ allow: false, reason: "timeout_deny" });
    expect(t.audit).toContainEqual(
      expect.objectContaining({ type: "approval.decision_rejected", reason: "missing_step_up" }),
    );
  });

  it("passkeyStepUp refuses to run without the unsigned body (nothing is sent)", async () => {
    const t = await setup((auth) => {
      const p = passkeyStepUp(
        { credentialId: auth.credentialId, rpId: RP_ID },
        { ceremonies: auth as unknown as Ceremonies },
      );
      return (approval) => p(approval);
    }, 300);
    const { outcome, error } = await t.run(true);
    expect(String(error)).toMatch(/unsigned decision body/);
    expect(outcome.allow).toBe(false);
    expect(t.db.rows("approval_decisions")).toHaveLength(0);
  });

  it("a deny needs no step-up and is accepted", async () => {
    const t = await setup(() => async () => {
      throw new ActionError("not_allowed", "should not be asked");
    });
    const { outcome } = await t.run(false);
    expect(outcome).toMatchObject({ allow: false, reason: "signed_deny" });
    await tick();
  });
});
