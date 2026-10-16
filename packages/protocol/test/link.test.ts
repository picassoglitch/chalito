import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import * as a2a from "@a2a-js/sdk";
import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  agentCardFromRecipe,
  CODING_SESSION_SKILL,
  isLinkableRecipe,
  LinkArtifact,
  LinkMessage,
  LinkPart,
  LinkStreamResponse,
  LinkTask,
  LinkUpdate,
  Recipe,
} from "../src/index.js";

const msg = {
  messageId: "m1",
  contextId: "s1",
  taskId: "t1",
  role: "ROLE_USER",
  parts: [{ text: "Arregla el test" }],
} as const;

const task = {
  id: "t1",
  contextId: "s1",
  status: {
    state: "TASK_STATE_WORKING",
    message: {
      messageId: "m2",
      contextId: "s1",
      taskId: "t1",
      role: "ROLE_AGENT",
      parts: [{ data: { tool: { toolUseId: "item_3", toolName: "Bash", status: "started" } } }],
    },
    timestamp: "2026-10-15T12:00:00.000Z",
  },
  history: [msg],
  artifacts: [
    {
      artifactId: "t1:reply",
      name: "reply",
      parts: [{ text: "Listo." }, { url: "https://example.com/r.diff", mediaType: "text/x-diff", filename: "r.diff" }],
    },
  ],
  metadata: { usage: { tokIn: 1, tokOut: 2, tokCacheRead: 0, tokCacheWrite: 0 } },
};

const card = {
  name: "Claude Code",
  description: "A coding agent.",
  supportedInterfaces: [{ url: "https://a2a.example.com/v1", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  provider: { url: "https://example.com", organization: "Anthropic" },
  version: "1",
  capabilities: { streaming: true, pushNotifications: false },
  securitySchemes: {
    chalito: {
      oauth2SecurityScheme: {
        flows: {
          authorizationCode: {
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            scopes: { "link:handoff": "Hand work to this agent" },
            pkceRequired: true,
          },
        },
      },
    },
  },
  securityRequirements: [{ schemes: { chalito: { list: ["link:handoff"] } } }],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain", "application/json"],
  skills: [{ id: "coding-session", name: "Coding session", description: "Codes.", tags: ["coding"] }],
};

describe("Link format: A2A v1.0 shapes", () => {
  it("accepts a task, message, artifact and card", () => {
    expect(LinkTask.safeParse(task).success).toBe(true);
    expect(LinkMessage.safeParse(msg).success).toBe(true);
    expect(LinkArtifact.safeParse(task.artifacts[0]).success).toBe(true);
    expect(AgentCard.safeParse(card).success).toBe(true);
  });

  it("matches the official SDK's JSON exactly (fromJSON → toJSON round-trip loses nothing)", () => {
    expect(A2A_PROTOCOL_VERSION).toBe(a2a.A2A_PROTOCOL_VERSION);
    expect(a2a.Task.toJSON(a2a.Task.fromJSON(task))).toEqual(task);
    expect(a2a.Message.toJSON(a2a.Message.fromJSON(msg))).toEqual(msg);
    expect(a2a.AgentCard.toJSON(a2a.AgentCard.fromJSON(card))).toEqual(card);
    const updates = [
      { task },
      { message: msg },
      { statusUpdate: { taskId: "t1", contextId: "s1", status: { state: "TASK_STATE_COMPLETED" } } },
      {
        artifactUpdate: {
          taskId: "t1",
          contextId: "s1",
          artifact: { artifactId: "a", parts: [{ text: "x" }] },
          append: true,
          lastChunk: true,
        },
      },
    ];
    for (const u of updates) {
      expect(LinkStreamResponse.safeParse(u).success).toBe(true);
      expect(a2a.StreamResponse.toJSON(a2a.StreamResponse.fromJSON(u))).toEqual(u);
    }
  });

  it("every A2A v1.0 task state is a LinkTaskState, nothing else", () => {
    const sdk = Object.keys(a2a.TaskState).filter((k) => k.startsWith("TASK_STATE_") && k !== "TASK_STATE_UNSPECIFIED");
    for (const state of sdk) expect(LinkTask.safeParse({ ...task, status: { state } }).success, state).toBe(true);
    expect(sdk).toHaveLength(8);
    // v0.3's lowercase names and `kind` discriminator are not v1.0.
    expect(LinkTask.safeParse({ ...task, status: { state: "working" } }).success).toBe(false);
    expect(LinkTask.safeParse({ ...task, status: { state: "TASK_STATE_UNSPECIFIED" } }).success).toBe(false);
    expect(LinkMessage.safeParse({ ...msg, role: "user" }).success).toBe(false);
  });

  it("a part has exactly one of text, url or data; inline raw bytes are refused", () => {
    expect(LinkPart.safeParse({ text: "a" }).success).toBe(true);
    expect(LinkPart.safeParse({ data: { a: 1 } }).success).toBe(true);
    expect(LinkPart.safeParse({ url: "https://x.example/a" }).success).toBe(true);
    expect(LinkPart.safeParse({}).success).toBe(false);
    expect(LinkPart.safeParse({ text: "a", url: "https://x.example/a" }).success).toBe(false);
    expect(LinkPart.safeParse({ raw: "AAAA" }).success).toBe(false);
    expect(LinkPart.safeParse({ text: "a", mediaType: "not a type" }).success).toBe(false);
    expect(LinkMessage.safeParse({ ...msg, parts: [] }).success).toBe(false);
  });

  it("a security scheme and an OAuth flow are each exactly one", () => {
    const two = {
      ...card,
      securitySchemes: {
        x: { mtlsSecurityScheme: {}, openIdConnectSecurityScheme: { openIdConnectUrl: "https://x.example" } },
      },
    };
    expect(AgentCard.safeParse(two).success).toBe(false);
    expect(AgentCard.safeParse({ ...card, securitySchemes: { x: {} } }).success).toBe(false);
    expect(
      AgentCard.safeParse({
        ...card,
        securitySchemes: { x: { apiKeySecurityScheme: { location: "body", name: "k" } } },
      }).success,
    ).toBe(false);
  });

  it("LinkUpdate is the v1 container; A2A objects themselves carry no v", () => {
    expect(LinkUpdate.safeParse({ v: 1, update: { task } }).success).toBe(true);
    expect(LinkUpdate.safeParse({ v: 2, update: { task } }).success).toBe(false);
    expect(LinkUpdate.safeParse({ v: 1, update: { task, message: msg } }).success).toBe(false);
    expect(LinkUpdate.safeParse({ v: 1, update: { task }, extra: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------- cards from the curated recipes

const recipesDir = fileURLToPath(new URL("../../../recipes/", import.meta.url));
const recipes = readdirSync(recipesDir)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => {
    const { verification: _v, ...doc } = parse(readFileSync(recipesDir + f, "utf8")) as Record<string, unknown>;
    return Recipe.parse(doc);
  });

describe("agentCardFromRecipe", () => {
  it("every agent-protocol recipe gets a valid card; terminals, desktop and web apps get none", () => {
    expect(recipes.length).toBeGreaterThan(10);
    const linkable = recipes.filter(isLinkableRecipe).map((r) => r.id);
    expect(linkable).toEqual(expect.arrayContaining(["claude-code", "codex", "gemini", "grok", "opencode", "goose"]));
    for (const r of recipes) {
      const c = agentCardFromRecipe(r);
      if (!isLinkableRecipe(r)) {
        expect(c, r.id).toBeNull();
        continue;
      }
      expect(AgentCard.safeParse(c).success, r.id).toBe(true);
      expect(a2a.AgentCard.toJSON(a2a.AgentCard.fromJSON(c))).toEqual(c);
      expect(c).toMatchObject({
        name: r.name,
        provider: { organization: r.vendor, url: r.homepage },
        skills: [{ id: CODING_SESSION_SKILL, tags: ["coding", r.id] }],
      });
      expect(c!.supportedInterfaces).toBeUndefined();
    }
    for (const id of ["chatgpt", "claude-web", "aider"]) {
      const r = recipes.find((x) => x.id === id);
      if (r) expect(agentCardFromRecipe(r), id).toBeNull();
    }
  });

  it("the card carries no commands, profiles, keys or paths from the recipe", () => {
    for (const r of recipes.filter(isLinkableRecipe)) {
      const s = JSON.stringify(agentCardFromRecipe(r));
      const argvs = [r.driver.acp?.command, r.driver.terminal?.command, r.signin.command, r.signin.statusCommand];
      for (const leak of [
        ...argvs.flatMap((a) => (a && a.length > 1 ? [a.join(" ")] : [])),
        ...argvs.flatMap((a) => (a ?? []).filter((x) => x.startsWith("-") || x.includes("/"))),
        r.apiKey?.env,
        ...Object.keys(r.profile?.env ?? {}),
        "{chalito}",
      ].filter((x): x is string => typeof x === "string" && x.length > 3 && !r.name.includes(x)))
        expect(s, `${r.id}: ${leak}`).not.toContain(leak);
    }
  });

  it("interfaces and security come from the caller (Phase D)", () => {
    const r = recipes.find((x) => x.id === "claude-code")!;
    const c = agentCardFromRecipe(r, {
      supportedInterfaces: card.supportedInterfaces,
      securitySchemes: card.securitySchemes as never,
      securityRequirements: card.securityRequirements,
      version: "2",
    });
    expect(c).toMatchObject({
      version: "2",
      supportedInterfaces: card.supportedInterfaces,
      securityRequirements: card.securityRequirements,
    });
    expect(AgentCard.safeParse(c).success).toBe(true);
  });
});
