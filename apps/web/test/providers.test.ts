// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("onboarding coding agents from providers.yaml", () => {
  it("lists the guided agents only; gemini-cli in providers.yaml doesn't break the build", async () => {
    const { agentOptions } = await import("@/lib/providers");
    expect(agentOptions().map((a) => a.agent)).toEqual(["claude-code", "codex", "grok-build"]);
  });
});
