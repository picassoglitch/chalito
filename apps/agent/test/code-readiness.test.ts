import { describe, expect, it } from "vitest";
import { codeService } from "../src/code/service.js";
import { agentFor } from "./rc-harness.js";

describe("local session picker readiness", () => {
  it("omits a pinned app when its adapter unloads or local policy disables it", async () => {
    const a = await agentFor();
    const service = codeService(
      a.core,
      () => a.policy.get(),
      () => ({
        adapters: ["claude-code"],
        workspaces: 1,
        labels: ["work"],
      }),
      "local",
    );
    expect(service.apps().apps).toEqual(["claude-code"]);
    const p = a.policy.get();
    await a.policy.set({ ...p, adapters: { ...p.adapters, claudeCode: false } }, "local");
    expect(service.apps().apps).toEqual([]);
    await a.policy.set(p, "local");
    expect(service.apps().apps).toEqual(["claude-code"]);
    a.core.setAdapters({});
    expect(service.apps().apps).toEqual([]);
  });
});
