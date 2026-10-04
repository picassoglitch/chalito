/** Beta security review proofs. FAILS on origin/all b026abf until R-M5 is fixed. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { estimateBillable, llmCostMicros } from "@chalito/billing";
import { loadPrices } from "@chalito/config";
import { runTurn } from "../src/turn.js";
import { OWNER, harness, mocks } from "./harness.js";

const m = mocks();
beforeAll(() => m.server.listen({ onUnhandledFrame: "error" }));
afterAll(() => m.server.close());

describe("R-M5: Mesa turns reserve billable tokens, not raw LLM tokens", () => {
  it("the admit estimate covers at least the output's billable cost", async () => {
    const h = await harness();
    await runTurn(h.deps, {
      owner: OWNER,
      deviceId: "dev_phone",
      mid: h.mid,
      tid: "in_rb_1",
      text: "@Claude hola",
      source: "owner",
      goal: "",
      card: null,
      recent: [],
      locale: "es",
    });
    const est = m.hub.find((x) => x.path === "admit")!.body.est_tokens as number;
    const outputOnly = estimateBillable(
      llmCostMicros(loadPrices(), "anthropic", "claude-sonnet-5-5", { input: 0, output: 800 }),
    );
    expect(est).toBeGreaterThanOrEqual(outputOnly);
  });
});
