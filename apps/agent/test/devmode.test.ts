import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLiabilityText } from "@chalito/config";
import { generateSigningKeyPair, verifyDetached, type SigningKeyPair } from "@chalito/crypto";
import { ANCHOR_SECRET, AnchorStore } from "../src/anchor.js";
import { DevMode, DevModeStore, type ConfirmPrompter } from "../src/devmode.js";
import { MemorySecretStore } from "../src/secrets.js";

const KEYS: SigningKeyPair = await generateSigningKeyPair();

const setup = (
  answers: { os?: boolean; first?: boolean; second?: boolean; checked?: boolean; typed?: string },
  head?: AnchorStore,
  dir = mkdtempSync(join(tmpdir(), "chalito-dm-")),
) => {
  const store = new DevModeStore(dir, KEYS, "dev_agent", head);
  const events: { type: string }[] = [];
  const asked: string[] = [];
  const liability = loadLiabilityText("es");
  const prompter: ConfirmPrompter = {
    first: async () => (asked.push("first"), answers.first ?? true),
    second: async () => (asked.push("second"), answers.second ?? true),
    liability: async () => (
      asked.push("liability"),
      { checked: answers.checked ?? true, typed: answers.typed ?? liability.phrase }
    ),
  };
  const dm = new DevMode({
    store,
    osAuth: { verify: async () => answers.os ?? true },
    prompter,
    liability,
    deviceId: "dev_agent",
    now: () => 1_790_000_000_000,
    emit: async (e) => void events.push(e),
  });
  return { dm, store, events, asked, dir };
};

describe("Developer mode (local only)", () => {
  it("a toggle needs all three confirmations and writes a liability record", async () => {
    const { dm, store, events, asked } = setup({});
    const res = await dm.enableToggle("allowSudo");
    expect(res).toMatchObject({ ok: true, state: { on: true, toggles: ["allowSudo"] } });
    expect(asked).toEqual(["first", "second", "liability"]);
    const [rec] = store.liabilityRecords();
    expect(rec).toMatchObject({ toggle: "allowSudo", deviceId: "dev_agent", textVersion: 1, locale: "es" });
    expect(rec!.text).toContain("Chalito no es responsable");
    expect(events.map((e) => e.type)).toEqual(["devmode.liability_accepted", "devmode.changed"]);
  });

  for (const [step, answers] of [
    ["OS auth", { os: false }],
    ["first confirmation", { first: false }],
    ["second confirmation", { second: false }],
    ["unchecked box", { checked: false }],
    ["wrong phrase", { typed: "acepto?" }],
  ] as const) {
    it(`cancelling at ${step} leaves it off and writes no acceptance`, async () => {
      const { dm, store, events } = setup(answers);
      expect((await dm.enableToggle("autoApproveHigh")).ok).toBe(false);
      expect(store.read().on).toBe(false);
      expect(store.records()).toHaveLength(0);
      expect(events).toHaveLength(0);
    });
  }

  it("turning a toggle or the whole mode off always works", async () => {
    const { dm } = setup({});
    await dm.enableToggle("allowSudo");
    await dm.enableToggle("autoApproveHigh");
    expect(dm.state.toggles).toEqual(["allowSudo", "autoApproveHigh"]);
    expect((await dm.toggleOff("allowSudo", "client:p1")).toggles).toEqual(["autoApproveHigh"]);
    expect(await dm.off("client:p1")).toEqual({ on: false, toggles: [], since: null });
  });

  it("the local audit log is hash-chained, so edits are detectable", async () => {
    const { dm, store, dir } = setup({});
    await dm.enableToggle("allowSudo");
    await dm.enableToggle("autoApproveHigh");
    expect(store.verifyChain()).toBe(true);
    const file = join(dir, "audit", "devmode.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace("allowSudo", "autoApproveCritical"));
    expect(store.verifyChain()).toBe(false);
  });

  it("a hand-written devmode.json (no agent signature) reads as off and is reported", async () => {
    const { dm, dir, events } = setup({});
    writeFileSync(join(dir, "devmode.json"), JSON.stringify({ on: true, toggles: ["autoApproveCritical"], since: 1 }));
    expect(dm.state).toEqual({ on: false, toggles: [], since: null });
    expect(events).toContainEqual({ type: "devmode.tampered", reason: "state_signature" });
    // Reported once, not on every read.
    void dm.state;
    expect(events.filter((e) => e.type === "devmode.tampered")).toHaveLength(1);
  });

  it("editing a signed devmode.json breaks the signature", async () => {
    const { dm, dir } = setup({});
    await dm.enableToggle("autoApproveHigh");
    const f = join(dir, "devmode.json");
    writeFileSync(f, readFileSync(f, "utf8").replace('"autoApproveHigh"', '"autoApproveHigh","autoApproveCritical"'));
    expect(dm.state.on).toBe(false);
  });

  it("a toggle without a signed liability record counts as off", async () => {
    const { dm, store, events } = setup({});
    await dm.enableToggle("allowSudo");
    // Validly signed state (as if written with the key) but no record for autoApproveCritical.
    store.write({ on: true, toggles: ["allowSudo", "autoApproveCritical"], since: 1 });
    expect(dm.state.toggles).toEqual(["allowSudo"]);
    expect(events).toContainEqual({ type: "devmode.tampered", reason: "toggle_unbacked" });
  });

  it("replaying an older signed state after turning off is detected", async () => {
    const { dm, dir } = setup({});
    await dm.enableToggle("autoApproveCritical");
    const f = join(dir, "devmode.json");
    const old = readFileSync(f, "utf8");
    await dm.off("local");
    writeFileSync(f, old);
    expect(dm.state.on).toBe(false);
    expect(new DevModeStore(dir, KEYS, "dev_agent").inspect().tampered).toBe("stale_state");
  });

  it("audit lines not signed by the agent key break the chain and force off", async () => {
    const { dm, store, dir } = setup({});
    await dm.enableToggle("allowSudo");
    const other = new DevModeStore(dir, await generateSigningKeyPair(), "dev_agent");
    other.append({ type: "devmode.disabled", toggles: [], deviceId: "dev_agent", by: "x", t: 1 });
    expect(store.verifyChain()).toBe(false);
    expect(dm.state.on).toBe(false);
  });

  it("local signatures interoperate with @chalito/crypto", async () => {
    const { dm, store } = setup({});
    await dm.enableToggle("allowSudo");
    const { sig, ...body } = store.liabilityRecords()[0]!;
    expect(await verifyDetached("chalito.devmode-liability.v1", body, sig, KEYS.publicKey)).toBe(true);
  });
});

describe("Developer mode: audit chain head in the OS keychain (rollback)", () => {
  const withHead = async () => {
    const secrets = new MemorySecretStore();
    const head = await new AnchorStore(secrets).load();
    return { secrets, head, ...setup({}, head) };
  };
  const audit = (dir: string) => join(dir, "audit", "devmode.jsonl");
  const state = (dir: string) => join(dir, "devmode.json");

  it("every append moves the keychain head (hash + count)", async () => {
    const { dm, store, secrets } = await withHead();
    await dm.enableToggle("allowSudo");
    await dm.enableToggle("autoApproveHigh");
    const records = store.records();
    expect(JSON.parse((await secrets.get(ANCHOR_SECRET))!).devmode).toEqual({
      hash: records.at(-1)!.hash,
      count: 2,
      epoch: 0,
    });
    expect(dm.state.toggles).toEqual(["allowSudo", "autoApproveHigh"]);
  });

  it("truncating the log and restoring an older state reads as rollback → off", async () => {
    const { dm, dir, events } = await withHead();
    await dm.enableToggle("autoApproveCritical");
    const oldState = readFileSync(state(dir), "utf8");
    const oldLog = readFileSync(audit(dir), "utf8");
    await dm.off("local");
    // Both files put back exactly as they were while the toggle was on: consistent and validly signed.
    writeFileSync(state(dir), oldState);
    writeFileSync(audit(dir), oldLog);
    expect(dm.state.on).toBe(false);
    expect(events).toContainEqual({ type: "devmode.tampered", reason: "rollback" });
  });

  it("without the keychain head the same restore would have passed (what the head adds)", async () => {
    const { dm, dir } = setup({});
    await dm.enableToggle("autoApproveCritical");
    const oldState = readFileSync(state(dir), "utf8");
    const oldLog = readFileSync(audit(dir), "utf8");
    await dm.off("local");
    writeFileSync(state(dir), oldState);
    writeFileSync(audit(dir), oldLog);
    expect(dm.state.on).toBe(true);
  });

  it("a removed keychain head while records exist reads as rollback", async () => {
    const { dm, secrets, head, dir } = await withHead();
    await dm.enableToggle("allowSudo");
    await secrets.delete(ANCHOR_SECRET);
    // A fresh process (no in-memory high-water mark) sees no anchor at all.
    const head2 = await new AnchorStore(secrets).load();
    void head;
    expect(new DevModeStore(dir, KEYS, "dev_agent", head2).inspect()).toMatchObject({
      state: { on: false },
      tampered: "rollback",
    });
  });

  it("a log ahead of the daemon's cached head (the CLI appended since) is still accepted", async () => {
    const secrets = new MemorySecretStore();
    const cli = setup({}, await new AnchorStore(secrets).load());
    await cli.dm.enableToggle("allowSudo");
    // The daemon loaded the head here, then the CLI appended again.
    const daemonHead = await new AnchorStore(secrets).load();
    await cli.dm.enableToggle("autoApproveHigh");
    const daemonView = new DevModeStore(cli.dir, KEYS, "dev_agent", daemonHead);
    expect(daemonHead.devmodeHead()!.count).toBe(1);
    expect(daemonView.inspect()).toEqual({
      state: expect.objectContaining({ on: true, toggles: ["allowSudo", "autoApproveHigh"] }),
      tampered: null,
    });
  });

  it("the anchor never moves backwards in-process, even if the keychain does (high-water mark)", async () => {
    const secrets = new MemorySecretStore();
    const a = await new AnchorStore(secrets).load();
    await a.setDevmodeHead({ hash: "b", count: 2, epoch: 0 });
    await a.setDevmodeHead({ hash: "a", count: 1, epoch: 0 });
    expect(a.devmodeHead()).toEqual({ hash: "b", count: 2, epoch: 0 });
    await secrets.set(ANCHOR_SECRET, JSON.stringify({ devmode: { hash: "a", count: 1, epoch: 0 }, policy: null }));
    await a.load();
    expect(a.devmodeHead()).toEqual({ hash: "b", count: 2, epoch: 0 });
    // A reset's new epoch moves it forward even with a lower count.
    await a.setDevmodeHead({ hash: "r", count: 1, epoch: 1 });
    expect(a.devmodeHead()).toEqual({ hash: "r", count: 1, epoch: 1 });
  });

  it("migrates m3-cli-2's devmode-chain-head entry", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("devmode-chain-head", JSON.stringify({ hash: "h", count: 3 }));
    expect((await new AnchorStore(secrets).load()).devmodeHead()).toEqual({ hash: "h", count: 3, epoch: 0 });
  });
});

describe("Developer mode: concurrent writers and reset", () => {
  it("a held lock makes a second writer wait; a stale lock is taken over", async () => {
    const { dm, store, dir } = setup({});
    writeFileSync(join(dir, "audit", "devmode.lock"), "other");
    const p = dm.enableToggle("allowSudo");
    await new Promise((r) => setTimeout(r, 60));
    expect(store.records()).toHaveLength(0);
    rmSync(join(dir, "audit", "devmode.lock"));
    await p;
    expect(store.verifyChain()).toBe(true);

    writeFileSync(join(dir, "audit", "devmode.lock"), "dead");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "audit", "devmode.lock"), old, old);
    await dm.enableToggle("autoApproveHigh");
    expect(dm.state.toggles).toEqual(["allowSudo", "autoApproveHigh"]);
  });

  it("parallel writers in one chain never fork it", async () => {
    const { dir } = setup({});
    const a = setup({}, undefined, dir);
    const b = setup({}, undefined, dir);
    await Promise.all([a.dm.enableToggle("allowSudo"), b.dm.off("client:p1"), a.dm.enableToggle("autoApproveHigh")]);
    expect(a.store.verifyChain()).toBe(true);
  });

  it("reset (OS auth + typed confirm) archives a forked chain and starts a new epoch, all off", async () => {
    const secrets = new MemorySecretStore();
    const anchor = await new AnchorStore(secrets).load();
    const { dm, store, dir, events } = setup({}, anchor);
    await dm.enableToggle("allowSudo");
    // Fork: a junk line breaks the chain for good.
    appendFileSync(join(dir, "audit", "devmode.jsonl"), '{"junk":true}\n');
    expect(store.verifyChain()).toBe(false);
    expect(dm.state.on).toBe(false);

    expect(await dm.reset("local", async () => false)).toEqual({ ok: false, reason: "cancelled" });
    expect(await dm.reset("local", async () => true)).toEqual({ ok: true });
    const records = store.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "devmode.reset", epoch: 1, by: "local" });
    expect(readdirSync(join(dir, "audit")).some((f) => f.endsWith(".archived.jsonl"))).toBe(true);
    expect(store.verifyChain()).toBe(true);
    expect(store.inspect()).toEqual({ state: { on: false, toggles: [], since: null }, tampered: null });
    expect(anchor.devmodeHead()).toMatchObject({ epoch: 1, count: 1 });
    expect(events.map((e) => e.type)).toContain("devmode.reset");

    // Works normally afterwards, and the archived (old-epoch) chain can't be restored.
    await dm.enableToggle("autoApproveHigh");
    expect(dm.state.toggles).toEqual(["autoApproveHigh"]);
  });

  it("reset refuses without OS auth", async () => {
    const { dm } = setup({ os: false });
    expect(await dm.reset("local", async () => true)).toEqual({ ok: false, reason: "os_auth_failed" });
  });

  it("restoring the pre-reset chain after a reset reads as rollback", async () => {
    const anchor = await new AnchorStore(new MemorySecretStore()).load();
    const { dm, dir } = setup({}, anchor);
    await dm.enableToggle("autoApproveCritical");
    const oldState = readFileSync(join(dir, "devmode.json"), "utf8");
    const oldLog = readFileSync(join(dir, "audit", "devmode.jsonl"), "utf8");
    await dm.reset("local", async () => true);
    writeFileSync(join(dir, "devmode.json"), oldState);
    writeFileSync(join(dir, "audit", "devmode.jsonl"), oldLog);
    expect(new DevModeStore(dir, KEYS, "dev_agent", anchor).inspect().tampered).toBe("rollback");
  });
});
