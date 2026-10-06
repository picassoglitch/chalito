import type { Recipe } from "@chalito/protocol";
import { AcpAdapter, BUILTIN_ACP_RECIPES } from "@chalito/adapters/acp";
import { describe, expect, it } from "vitest";
import { acpDriver, acpDriverFactory, buildDrivers, driverFor } from "../src/drivers/index.js";
import { createLogger } from "../src/redact.js";

const log = createLogger(() => undefined);
const ctx = { home: "/h/.chalito/x", env: {}, log };

describe("driver registry", () => {
  it('has the ACP driver registered under "acp"', () => {
    expect(driverFor("acp")).toBe(acpDriverFactory);
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

  it("the engine builds an app's ACP session adapter through the registry (and skips unsafe ones)", async () => {
    const recipe = (command: string[]) =>
      ({
        v: 1,
        id: "goose",
        name: "Goose",
        kinds: ["acp"],
        driver: { acp: { command } },
      }) as unknown as Recipe;
    const base = { custom: false, auth: { signIn: true }, dir: "/h/.chalito", platform: "linux" as const, ...ctx };
    const built = await buildDrivers({ ...base, recipe: recipe(["goose", "acp"]), bin: "/opt/goose" });
    expect(built.map((b) => b.kind)).toEqual(["acp"]);
    expect(built[0]!.driver.adapter).toBeInstanceOf(AcpAdapter);
    expect(await buildDrivers({ ...base, recipe: recipe(["goose", "acp"]), bin: null })).toEqual([]);
    expect(await buildDrivers({ ...base, recipe: recipe(["goose", "acp", "--yolo"]), bin: "/opt/goose" })).toEqual([]);
  });
});
