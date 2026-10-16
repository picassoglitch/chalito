import { agentCardFromRecipe, isLinkableRecipe, type Recipe } from "@chalito/protocol";
import { ChatApiAdapter } from "@chalito/adapters/chat-api";
import { A2aAdapter } from "@chalito/adapters/a2a";
import { describe, expect, it } from "vitest";
import { BUILTIN_CATALOG } from "../src/apps/catalog.js";
import { a2aDriverFactory, buildDrivers, chatApiDriverFactory, driverFor } from "../src/drivers/index.js";
import { createLogger } from "../src/redact.js";

/** M16 D (ADR 0022 §4): the chat-api and a2a drivers, and what the curated catalog says about them. */
const log = createLogger(() => undefined);
const recipe = (id: string) => BUILTIN_CATALOG.recipes.find((r) => r.id === id)!;
const ctx = (r: Recipe, apiKey?: string) => ({
  recipe: r,
  custom: false,
  bin: null,
  auth: { ...(apiKey ? { apiKey } : {}), signIn: false },
  env: {},
  home: "/h/.chalito/apps/x",
  dir: "/h/.chalito",
  platform: "linux" as const,
  log,
});
const a2aRecipe: Recipe = {
  v: 1,
  id: "remote-helper",
  name: "Remote helper",
  vendor: "Example",
  homepage: "https://agent.example.com/",
  termsUrl: "https://agent.example.com/terms",
  kinds: ["a2a"],
  platforms: {},
  signin: { via: "api-key", planSignin: "off" },
  apiKey: { env: "REMOTE_HELPER_TOKEN", label: "Token", docsUrl: "https://agent.example.com/docs" },
  driver: { a2a: { url: "https://agent.example.com" } },
  capabilities: ["sessions"],
};

describe("chat-api and a2a drivers", () => {
  it("are registered under their kinds", () => {
    expect(driverFor("chat-api")).toBe(chatApiDriverFactory);
    expect(driverFor("a2a")).toBe(a2aDriverFactory);
  });

  it("a keyed provider builds only with the person's key; a local server needs none", async () => {
    expect(await chatApiDriverFactory(ctx(recipe("xai-api")))).toBeNull();
    const keyed = await chatApiDriverFactory(ctx(recipe("xai-api"), "xai-k"));
    expect(keyed?.adapter).toBeInstanceOf(ChatApiAdapter);
    expect(keyed?.adapter?.kind).toBe("chat-api");
    const local = await buildDrivers(ctx(recipe("ollama-api")));
    expect(local.map((d) => d.kind)).toEqual(["chat-api"]);
  });

  it("an a2a recipe builds an A2A client adapter (with its key)", async () => {
    expect(await a2aDriverFactory(ctx(a2aRecipe))).toBeNull();
    const d = await a2aDriverFactory(ctx(a2aRecipe, "tok"));
    expect(d?.adapter).toBeInstanceOf(A2aAdapter);
    expect(d?.adapter?.kind).toBe("a2a");
  });
});

describe("the catalog: connectable or not (ADR 0022 §4)", () => {
  const AGENT = new Set(["claude-sdk", "codex", "acp", "chat-api", "a2a"]);

  it("every recipe either has an agent driver or says why it isn't connectable; no website is driven as an agent", () => {
    for (const r of BUILTIN_CATALOG.recipes) {
      const agent = r.kinds.some((k) => AGENT.has(k));
      expect(agent || !!r.notConnectable, r.id).toBe(true);
      expect(agent && !!r.notConnectable, r.id).toBe(false);
      if (r.kinds.includes("web-app")) expect(r.notConnectable?.reason, r.id).toMatch(/never drives chat websites/);
    }
  });

  it("chat-api recipes: the person's own key (or none, on loopback); cards come from the recipe", () => {
    const chat = BUILTIN_CATALOG.recipes.filter((r) => r.kinds.includes("chat-api"));
    expect(chat.map((r) => r.id).sort()).toEqual(
      ["deepseek-api", "groq", "lm-studio-api", "mistral-api", "ollama-api", "openrouter", "xai-api"].sort(),
    );
    for (const r of chat) {
      const url = new URL(r.driver.chatApi!.baseUrl);
      if (url.protocol === "http:") {
        expect(url.hostname, r.id).toBe("localhost");
        expect(r.signin.via, r.id).toBe("none");
      } else {
        expect(r.signin.via, r.id).toBe("api-key");
        expect(r.apiKey, r.id).toBeDefined();
      }
      expect(r.signin.planSignin, r.id).toBe("off");
      expect(isLinkableRecipe(r), r.id).toBe(true);
      const card = agentCardFromRecipe(r)!;
      expect(card.skills.map((s) => s.id)).toEqual(["chat"]);
      // The card never carries the endpoint, model or key.
      expect(JSON.stringify(card)).not.toContain(r.driver.chatApi!.baseUrl);
    }
    expect(agentCardFromRecipe(a2aRecipe)!.skills.map((s) => s.id)).toEqual(["remote-agent"]);
    expect(agentCardFromRecipe(recipe("claude-web"))).toBeNull();
  });
});
