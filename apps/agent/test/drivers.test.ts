import { AcpAdapter, BUILTIN_ACP_RECIPES } from "@chalito/adapters/acp";
import { describe, expect, it } from "vitest";
import { acpDriver, driverFor, registerDriver } from "../src/drivers/index.js";
import { createLogger } from "../src/redact.js";

const log = createLogger(() => undefined);
const ctx = { home: "/h/.chalito/x", env: {}, log };

describe("driver registry", () => {
  it('has the ACP driver registered under "acp"', () => {
    expect(driverFor("acp")).toBe(acpDriver);
    // Registering the same factory again is a no-op; a different one is refused.
    expect(() => registerDriver("acp", acpDriver)).not.toThrow();
    expect(() =>
      registerDriver("acp", () => acpDriver({ ...ctx, recipe: BUILTIN_ACP_RECIPES.grok, binPath: "/g" })),
    ).toThrow(/already registered/);
  });

  it("builds an ACP adapter for any recipe with driver.acp", () => {
    const goose = acpDriver({
      ...ctx,
      recipe: {
        id: "goose",
        name: "Goose",
        apiKey: { env: "ANTHROPIC_API_KEY" },
        driver: { acp: { command: ["goose", "acp"] } },
      },
      binPath: "/opt/goose",
      apiKey: "k",
    });
    expect(goose).toBeInstanceOf(AcpAdapter);
    expect(goose.kind).toBe("acp");
    expect(goose.appId).toBe("goose");
    const grok = acpDriver({ ...ctx, recipe: BUILTIN_ACP_RECIPES.grok, binPath: "/opt/grok", signIn: true });
    expect(grok.kind).toBe("grok");
  });

  it("refuses an unpinned CLI and an unsafe recipe", () => {
    expect(() => acpDriver({ ...ctx, recipe: BUILTIN_ACP_RECIPES.gemini, signIn: true })).toThrow(/isn't pinned/);
    expect(() =>
      acpDriver({
        ...ctx,
        recipe: { id: "qwen-code", name: "Qwen Code", driver: { acp: { command: ["qwen", "--acp", "--yolo"] } } },
        binPath: "/opt/qwen",
        apiKey: "k",
      }),
    ).toThrow(/--yolo/);
  });
});
