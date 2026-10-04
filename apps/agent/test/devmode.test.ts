import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLiabilityText } from "@chalito/config";
import { DevMode, DevModeStore, type ConfirmPrompter } from "../src/devmode.js";

const setup = (answers: { os?: boolean; first?: boolean; second?: boolean; checked?: boolean; typed?: string }) => {
  const dir = mkdtempSync(join(tmpdir(), "chalito-dm-"));
  const store = new DevModeStore(dir);
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
    const [rec] = store.records();
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
});
