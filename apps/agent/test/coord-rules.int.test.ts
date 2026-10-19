/**
 * Remembered coordinator rules over the LOCAL Supabase stack (ADR 0025 §6): the phone stores a
 * signed rule as itself through real RLS, the agent reads it with its own device session and only
 * keeps it once it verifies against its local trusted list. Run by the `supabase` CI job.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TrustedClientList,
  deriveDeviceId,
  generateBoxKeyPair,
  generateSigningKeyPair,
  signEnvelope,
  toB64url,
} from "@chalito/crypto";
import { rememberMatchFor, ruleMatchText } from "@chalito/protocol";
import { CoordRules } from "../src/coord/rules.js";
import { createLogger } from "../src/redact.js";
import { SupabaseStore, type SupaClient } from "../src/supabase-store.js";
import { LOCAL, createDeviceUser, deviceDb, gotrue, q, seedOwner, type Db } from "./supabase-local.js";

const run = randomUUID().replace(/-/g, "").slice(0, 10);
const OWNER = `coord-int-${run}`;
const OTHER = `coord-int-other-${run}`;

describe.skipIf(!LOCAL)("remembered coordinator rules (local stack, real RLS)", () => {
  let admin: Db;
  const authIds: string[] = [];

  beforeAll(() => {
    admin = gotrue();
  });
  afterAll(async () => {
    for (const id of authIds) await admin?.auth.admin.deleteUser(id).catch(() => undefined);
  });

  it("the phone's signed rule reaches the agent and verifies; another owner's phone can't add one", async () => {
    const agentSign = await generateSigningKeyPair();
    const phoneSign = await generateSigningKeyPair();
    const strangerSign = await generateSigningKeyPair();
    const box = await generateBoxKeyPair();
    const agentId = await deriveDeviceId(agentSign.publicKey);
    const phoneId = await deriveDeviceId(phoneSign.publicKey);
    const strangerId = await deriveDeviceId(strangerSign.publicKey);
    authIds.push(await createDeviceUser(admin, OWNER, agentId, "agent"));
    authIds.push(await createDeviceUser(admin, OWNER, phoneId, "client"));
    authIds.push(await createDeviceUser(admin, OTHER, strangerId, "client"));
    const pubBox = await toB64url(box.publicKey);
    seedOwner(OWNER, [
      { deviceId: agentId, role: "agent", authUserId: authIds[0]!, pubBox },
      { deviceId: phoneId, role: "client", authUserId: authIds[1]!, pubBox },
    ]);
    seedOwner(OTHER, [{ deviceId: strangerId, role: "client", authUserId: authIds[2]!, pubBox }]);

    const match = createHash("sha256")
      .update(
        ruleMatchText(
          rememberMatchFor({ toolName: "Bash", input: { command: "pnpm format" }, workspaceLabel: "taquito" })!,
        )!,
      )
      .digest("hex");
    const now = Date.now();
    const env = await signEnvelope(
      "chalito.coordrule.v1",
      { v: 1, ruleId: `cr_${run}`, uid: OWNER, match, createdAt: now, expiresAt: now + 86_400_000 },
      phoneId,
      phoneSign.secretKey,
    );
    const phoneDb = await deviceDb(admin, phoneId);
    const ins = await phoneDb.from("coord_rules").insert({
      owner: OWNER,
      rule_id: `cr_${run}`,
      signer_device_id: phoneId,
      rule: env,
      expires_at: new Date(now + 86_400_000).toISOString(),
    });
    expect(ins.error).toBeNull();

    // Another owner's client can't write into this owner's rules.
    const strangerDb = await deviceDb(admin, strangerId);
    const bad = await strangerDb.from("coord_rules").insert({
      owner: OWNER,
      rule_id: `cr_x${run}`,
      signer_device_id: strangerId,
      rule: env,
      expires_at: new Date(now + 1000).toISOString(),
    });
    expect(bad.error).not.toBeNull();

    const agentDb = await deviceDb(admin, agentId);
    const store = new SupabaseStore(agentDb as unknown as SupaClient, OWNER, agentId, {
      log: createLogger(() => undefined),
    });
    expect(await store.listCoordRules()).toHaveLength(1);

    const trust = new TrustedClientList(agentId);
    await trust.addConfirmed({ deviceId: phoneId, pubSign: await toB64url(phoneSign.publicKey), pubBox }, now);
    const rules = new CoordRules({
      list: () => store.listCoordRules(),
      listRevocations: () => store.listCoordRuleRevocations(),
      refreshMs: 0,
      trust: () => trust,
      owner: OWNER,
      now: Date.now,
    });
    expect([...(await rules.matches())]).toEqual([match]);

    // The same row is worth nothing to an agent that doesn't trust the phone.
    const untrusting = new CoordRules({
      list: () => store.listCoordRules(),
      listRevocations: () => store.listCoordRuleRevocations(),
      trust: () => new TrustedClientList(agentId),
      owner: OWNER,
      now: Date.now,
    });
    expect((await untrusting.matches()).size).toBe(0);

    // The owner removes it from the phone and signs the withdrawal.
    const del = await phoneDb.from("coord_rules").delete().eq("rule_id", `cr_${run}`);
    expect(del.error).toBeNull();
    const rev = await phoneDb.from("coord_rule_revocations").insert({
      owner: OWNER,
      rule_id: `cr_${run}`,
      signer_device_id: phoneId,
      revoke: await signEnvelope(
        "chalito.coordrule-revoke.v1",
        { v: 1, uid: OWNER, ruleId: `cr_${run}`, revokedAt: Date.now() },
        phoneId,
        phoneSign.secretKey,
      ),
    });
    expect(rev.error).toBeNull();
    expect(await store.listCoordRules()).toHaveLength(0);
    expect((await rules.matches()).size).toBe(0);
    // Nobody deletes a withdrawal: not the agent, not the phone.
    await agentDb.from("coord_rule_revocations").delete().eq("rule_id", `cr_${run}`);
    await phoneDb.from("coord_rule_revocations").delete().eq("rule_id", `cr_${run}`);
    expect(await store.listCoordRuleRevocations()).toHaveLength(1);

    // The server re-inserts the same signed rule (a replay): still refused.
    // As the database owner: a compromised server, not anything the API may do.
    execFileSync("supabase", [
      "db",
      "query",
      "--local",
      `insert into chalito.coord_rules (owner, rule_id, signer_device_id, rule, expires_at) values (${q(OWNER)}, ${q(`cr_${run}`)}, ${q(phoneId)}, ${q(JSON.stringify(env))}::jsonb, now() + interval '1 day')`,
    ]);
    expect(await store.listCoordRules()).toHaveLength(1);
    expect((await rules.matches()).size).toBe(0);
  });
});
