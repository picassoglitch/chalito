import { describe, expect, it } from "vitest";
import {
  AppConnectionDoc,
  CommandPayload,
  Recipe,
  RecipeCatalog,
  SignedRecipeCatalog,
  APP_ADAPTER,
  PROVIDER_APP,
  isLegacyApp,
} from "../src/index.js";

const cli = {
  v: 1,
  id: "my-agent",
  name: "My agent",
  vendor: "Me",
  homepage: "https://example.com",
  termsUrl: "https://example.com/terms",
  kinds: ["acp", "terminal"],
  platforms: {
    linux: { detect: { commands: ["myagent"] }, install: { via: "npm", ref: "@me/my-agent" } },
  },
  signin: { via: "cli", command: ["myagent", "login"], planSignin: "on" },
  driver: { acp: { command: ["myagent", "acp"] }, terminal: { command: ["myagent"] } },
  capabilities: ["sessions", "terminal"],
};

const web = {
  v: 1,
  id: "some-chat",
  name: "Some chat",
  vendor: "Some",
  homepage: "https://chat.example.com",
  termsUrl: "https://chat.example.com/terms",
  kinds: ["web-app"],
  platforms: {},
  signin: { via: "web", url: "https://chat.example.com/login", planSignin: "on" },
  driver: { web: { startUrl: "https://chat.example.com/", allowedOrigins: ["https://chat.example.com"] } },
  capabilities: ["remote-view", "ai-control"],
};

const bad = (patch: Record<string, unknown>, base: Record<string, unknown> = cli) =>
  Recipe.safeParse({ ...base, ...patch }).success;

describe("Recipe", () => {
  it("accepts a CLI recipe and a web app", () => {
    expect(Recipe.safeParse(cli).success).toBe(true);
    expect(Recipe.safeParse(web).success).toBe(true);
  });

  it("ids are kebab-case recipe ids", () => {
    for (const id of ["My-Agent", "a", "../x", "x y", "-x", `a${"b".repeat(41)}`]) expect(bad({ id })).toBe(false);
  });

  it("unknown keys are refused (nothing smuggled into a recipe)", () => {
    expect(bad({ script: "curl evil | sh" })).toBe(false);
    expect(bad({ signin: { ...cli.signin, shell: true } })).toBe(false);
  });

  it("commands are argv, never a shell line or a path, and argv[0] is one of the app's commands", () => {
    expect(bad({ signin: { via: "cli", command: ["/usr/bin/myagent", "login"], planSignin: "on" } })).toBe(false);
    expect(bad({ signin: { via: "cli", command: ["sh", "-c", "myagent login"], planSignin: "on" } })).toBe(false);
    expect(bad({ driver: { ...cli.driver, terminal: { command: ["bash"] } } })).toBe(false);
    expect(bad({ signin: { via: "cli", command: ["myagent", "a\nb"], planSignin: "on" } })).toBe(false);
  });

  it("installs come from an official source and match its shape", () => {
    const withInstall = (install: unknown) =>
      Recipe.safeParse({ ...cli, platforms: { linux: { detect: { commands: ["myagent"] }, install } } }).success;
    expect(withInstall({ via: "npm", ref: "@me/my-agent" })).toBe(true);
    expect(withInstall({ via: "npm", ref: "my-agent; rm -rf ~" })).toBe(false);
    expect(withInstall({ via: "brew", ref: "my-agent", cask: true })).toBe(true);
    expect(withInstall({ via: "npm", ref: "x", cask: true })).toBe(false);
    expect(withInstall({ via: "winget", ref: "Me.MyAgent" })).toBe(true);
    expect(withInstall({ via: "winget", ref: "9PLM9XGG6VKS", source: "msstore" })).toBe(true);
    expect(withInstall({ via: "winget", ref: "Me.MyAgent", source: "msstore" })).toBe(false);
    expect(withInstall({ via: "official-url", ref: "https://example.com/download" })).toBe(true);
    expect(withInstall({ via: "official-url", ref: "http://example.com/download" })).toBe(false);
    expect(withInstall({ via: "curl", ref: "https://example.com/install.sh" })).toBe(false);
  });

  it("detect paths are absolute or under known folders, never with ..", () => {
    const withPaths = (paths: string[]) =>
      Recipe.safeParse({ ...cli, platforms: { linux: { detect: { commands: ["myagent"], paths } } } }).success;
    expect(withPaths(["/opt/x", "~/.local/bin/x", "%LOCALAPPDATA%\\Programs\\X\\X.exe"])).toBe(true);
    expect(withPaths(["relative/x"])).toBe(false);
    expect(withPaths(["~/../../etc/passwd"])).toBe(false);
    expect(withPaths(["%TEMP%\\x"])).toBe(false);
  });

  it("each kind needs its driver, and a web app's start page must be one of its allowed origins", () => {
    expect(bad({ driver: { terminal: cli.driver.terminal } })).toBe(false);
    expect(bad({ kinds: ["web-app"] })).toBe(false);
    expect(
      bad(
        { driver: { web: { startUrl: "https://evil.example/", allowedOrigins: ["https://chat.example.com"] } } },
        web,
      ),
    ).toBe(false);
    expect(
      bad(
        { driver: { web: { startUrl: "https://chat.example.com/", allowedOrigins: ["https://chat.example.com/x"] } } },
        web,
      ),
    ).toBe(false);
    expect(bad({ signin: { via: "web", url: "http://chat.example.com/login", planSignin: "on" } }, web)).toBe(false);
  });

  it("a sign-in names how: cli/acp need a command, web a url; interactive only for cli", () => {
    expect(bad({ signin: { via: "cli", planSignin: "on" } })).toBe(false);
    expect(bad({ signin: { via: "acp", command: ["myagent", "acp"], planSignin: "on" } })).toBe(false);
    expect(bad({ signin: { via: "acp", command: ["myagent", "acp"], acpMethod: "x", planSignin: "on" } })).toBe(true);
    expect(bad({ signin: { via: "desktop-app", interactive: true, planSignin: "on" } })).toBe(false);
    expect(bad({ signin: { ...cli.signin, statusJson: "loggedIn" } })).toBe(false);
  });

  it("a profile only points under ~/.chalito", () => {
    expect(bad({ profile: { env: { MYAGENT_HOME: "{chalito}/myagent" } } })).toBe(true);
    expect(bad({ profile: { env: { MYAGENT_HOME: "/home/me/.myagent" } } })).toBe(false);
    expect(bad({ profile: { env: { MYAGENT_HOME: "{chalito}/../x" } } })).toBe(false);
  });

  it("platforms may be empty only for web apps", () => {
    expect(bad({ platforms: {} })).toBe(false);
  });
});

describe("RecipeCatalog / SignedRecipeCatalog", () => {
  it("ids are unique", () => {
    expect(RecipeCatalog.safeParse({ v: 1, issuedAt: 1, recipes: [cli, web] }).success).toBe(true);
    expect(RecipeCatalog.safeParse({ v: 1, issuedAt: 1, recipes: [cli, cli] }).success).toBe(false);
  });

  it("the signed envelope has its own signing context and a key id", () => {
    const body = { v: 1, issuedAt: 1, recipes: [web] };
    const sig = "A".repeat(86);
    expect(
      SignedRecipeCatalog.safeParse({ ctx: "chalito.recipe-catalog.v1", keyId: "prod-1", body, sig }).success,
    ).toBe(true);
    expect(SignedRecipeCatalog.safeParse({ ctx: "chalito.command.v1", keyId: "prod-1", body, sig }).success).toBe(
      false,
    );
    expect(
      SignedRecipeCatalog.safeParse({ ctx: "chalito.recipe-catalog.v1", keyId: "Prod 1", body, sig }).success,
    ).toBe(false);
  });
});

describe("AppConnectionDoc", () => {
  const doc = {
    mode: null,
    connected: false,
    state: "available",
    cli: { installed: true, version: null },
    error: null,
    at: 1,
    kind: "web-app",
    custom: false,
  };
  it("is a status doc: closed states and codes, no paths, a name only for custom recipes", () => {
    expect(AppConnectionDoc.safeParse(doc).success).toBe(true);
    expect(AppConnectionDoc.safeParse({ ...doc, name: "ChatGPT" }).success).toBe(false);
    expect(AppConnectionDoc.safeParse({ ...doc, custom: true, name: "Mi agente" }).success).toBe(true);
    expect(AppConnectionDoc.safeParse({ ...doc, error: "EACCES /home/me" }).success).toBe(false);
    expect(AppConnectionDoc.safeParse({ ...doc, cli: { installed: true, version: null, path: "/x" } }).success).toBe(
      false,
    );
    expect(AppConnectionDoc.safeParse({ ...doc, recipe: cli }).success).toBe(false);
  });
});

describe("app.* commands", () => {
  it("parse, and app.connect seals its key like provider.connect", () => {
    expect(CommandPayload.safeParse({ type: "app.launch", appId: "chatgpt" }).success).toBe(true);
    expect(CommandPayload.safeParse({ type: "app.status" }).success).toBe(true);
    expect(CommandPayload.safeParse({ type: "app.connect", appId: "goose", method: "api_key" }).success).toBe(false);
    expect(CommandPayload.safeParse({ type: "app.install", appId: "../x" }).success).toBe(false);
  });

  it("no command enables a custom recipe or carries a recipe", () => {
    for (const type of ["app.enable", "app.custom", "apps.custom.enable", "recipe.add", "recipe.enable"])
      expect(CommandPayload.safeParse({ type, appId: "my-agent" }).success).toBe(false);
    for (const payload of [
      { type: "app.connect", appId: "my-agent", method: "signin" },
      { type: "app.install", appId: "my-agent" },
      { type: "app.launch", appId: "my-agent" },
    ]) {
      const parsed = CommandPayload.parse({ ...payload, enabled: true, custom: true, recipe: cli, sha256: "a" });
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(payload).sort());
    }
  });

  it("session.start takes an adapter, an app id, or both", () => {
    const promptCt = {
      alg: "xchacha20poly1305+sealedbox",
      nonce: "A".repeat(32),
      ct: "AA",
      keys: { d: "A".repeat(107) },
    };
    const base = { type: "session.start", workspaceLabel: "w", promptCt };
    expect(CommandPayload.safeParse({ ...base, adapter: "codex" }).success).toBe(true);
    expect(CommandPayload.safeParse({ ...base, appId: "goose" }).success).toBe(true);
    expect(CommandPayload.safeParse(base).success).toBe(false);
  });

  it("the four providers map to their apps and adapters", () => {
    expect(PROVIDER_APP).toEqual({ anthropic: "claude-code", openai: "codex", xai: "grok", google: "gemini" });
    for (const app of Object.values(PROVIDER_APP)) {
      expect(isLegacyApp(app)).toBe(true);
      expect(APP_ADAPTER[app]).toBe(app);
    }
    expect(isLegacyApp("goose")).toBe(false);
    expect(isLegacyApp("toString")).toBe(false);
  });
});
