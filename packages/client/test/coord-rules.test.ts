import { TrustedClientList, sha256, utf8 } from "@chalito/crypto";
import { CoordRule, CoordRuleRevoke, ruleMatchText } from "@chalito/protocol";
import { describe, expect, it } from "vitest";
import { CoordRuleError, CoordRulesClient, describeRule } from "../src/index.js";
import { FakeSupabase, newDevice, testKeys } from "./helpers.js";

const OWNER = "owner-1";
const NOW = 1_800_000_000_000;
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const setup = async () => {
  const me = await newDevice();
  const other = await newDevice();
  const db = new FakeSupabase();
  const rules = new CoordRulesClient({ db, keys: testKeys(me), owner: OWNER, now: () => NOW });
  const elsewhere = new CoordRulesClient({ db, keys: testKeys(other), owner: OWNER, now: () => NOW });
  return { me, other, db, rules, elsewhere };
};

const psql = { toolName: "Bash", input: { command: "supabase db push" }, workspaceLabel: "taquito", risk: "MED" };

describe("Siempre así (ADR 0025 §6)", () => {
  it("only a MED prompt of one plain command or web host can be remembered", async () => {
    const { rules } = await setup();
    expect(rules.matchFor(psql)).toEqual({
      kind: "command",
      workspaceLabel: "taquito",
      program: "supabase",
      sub: "db push",
    });
    expect(rules.matchFor({ ...psql, risk: "HIGH" })).toBeNull();
    expect(rules.matchFor({ ...psql, input: { command: "git add -A && rm -rf x" } })).toBeNull();
    await expect(rules.remember({ ...psql, risk: "CRITICAL" })).rejects.toBeInstanceOf(CoordRuleError);
  });

  it("stores a rule signed by this device that a computer trusting it verifies, with only a hash in the row", async () => {
    const { me, db, rules } = await setup();
    const id = await rules.remember(psql);
    const row = db.rows("coord_rules")[0]!;
    expect(row).toMatchObject({ owner: OWNER, rule_id: id, signer_device_id: me.deviceId });
    const env = CoordRule.parse(row.rule);
    expect(env.body.match).toBe(hex(await sha256(utf8(ruleMatchText(rules.matchFor(psql)!)!))));
    expect(JSON.stringify(row.rule)).not.toContain("supabase");
    expect(env.body.expiresAt - env.body.createdAt).toBe(90 * 24 * 60 * 60 * 1000);
    const trust = new TrustedClientList("dev_agent");
    await trust.addConfirmed({ deviceId: me.deviceId, pubSign: me.pubSign, pubBox: me.pubBox }, NOW);
    expect((await trust.verifySigned(env, "chalito.coordrule.v1")).ok).toBe(true);
  });

  it("lists the label on the device that made it and a blank one elsewhere", async () => {
    const { rules, elsewhere } = await setup();
    await rules.remember(psql);
    expect(await rules.list()).toMatchObject([{ label: "supabase db push · taquito", mine: true }]);
    expect(await elsewhere.list()).toMatchObject([{ label: null, mine: false }]);
  });

  it("removing a rule signs the withdrawal first, then deletes the row (from any of the owner's devices)", async () => {
    const { other, db, rules, elsewhere } = await setup();
    const id = await rules.remember(psql);
    await elsewhere.forget(id);
    const ops = db.ops.filter((o) => o.op !== "select").map((o) => `${o.op}:${o.table}`);
    expect(ops).toEqual(["insert:coord_rules", "insert:coord_rule_revocations", "delete:coord_rules"]);
    const rev = CoordRuleRevoke.parse(db.rows("coord_rule_revocations")[0]!.revoke);
    expect(rev).toMatchObject({ signerDeviceId: other.deviceId, body: { ruleId: id, uid: OWNER } });
    expect(db.rows("coord_rules")).toHaveLength(0);
  });

  it("describes a match briefly", () => {
    expect(describeRule({ kind: "web", workspaceLabel: "w", domain: "api.x.com" })).toBe("api.x.com · w");
  });
});
