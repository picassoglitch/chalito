import { z } from "zod";
import { AppId, type Recipe, type RecipeKind } from "./recipe.js";

/**
 * Chalito Link format (ADR 0022 §2): the language between agents and to the outside, shaped
 * one-to-one like **A2A v1.0** objects in their JSON form (ProtoJSON of `lf.a2a.v1`), so exposing
 * Chalito as an A2A server or calling an A2A agent (Phase D) needs no translation.
 *
 * Verified against the A2A spec 1.0.0 (a2a-protocol.org) and `@a2a-js/sdk` 1.3.0
 * (`A2A_PROTOCOL_VERSION = "1.0"`); see docs/VERIFIED_APIS.md "A2A". The protocol test round-trips
 * these objects through that SDK's own `fromJSON`/`toJSON`.
 *
 * Wire notes:
 * - Enums use the ProtoJSON names (`TASK_STATE_WORKING`, `ROLE_AGENT`), as A2A v1.0 JSON does.
 *   The v0.3 lowercase names (`working`, `kind: "task"`) are gone in v1.0 and are not accepted.
 * - These A2A objects carry no `v`: they are versioned by A2A itself (`protocolVersion` on the
 *   card's interfaces). The Chalito container `LinkUpdate` carries `v: 1` (D-067).
 * - Unknown fields are stripped, not refused (A2A peers may be on a newer minor version).
 * - What Chalito writes is canonical ProtoJSON: empty lists and `false` defaults are omitted, so
 *   the official SDK's `toJSON(fromJSON(x))` gives back exactly `x`.
 * - The current `AgentEvent` stays the wire format to phones; this is not a replacement for it.
 */

/** The A2A protocol version these shapes follow (Major.Minor, as A2A tracks compatibility). */
export const A2A_PROTOCOL_VERSION = "1.0" as const;

const Id = z.string().min(1).max(200);
const Metadata = z.record(z.string(), z.unknown());
const MediaType = z
  .string()
  .max(200)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(\s*;.*)?$/i, "a media type");
const Url = z.string().max(2000).url();

// ---------------------------------------------------------------- task state, role

export const LinkTaskState = z.enum([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);
export type LinkTaskState = z.infer<typeof LinkTaskState>;

/** Terminal states: the task never changes again. */
export const LINK_TERMINAL_STATES = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
] as const satisfies readonly LinkTaskState[];
/** Interrupted states: the task waits for the caller (more input, or authentication). */
export const LINK_INTERRUPTED_STATES = [
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
] as const satisfies readonly LinkTaskState[];

export const isTerminalLinkState = (s: LinkTaskState): boolean =>
  (LINK_TERMINAL_STATES as readonly LinkTaskState[]).includes(s);

export const LinkRole = z.enum(["ROLE_USER", "ROLE_AGENT"]);
export type LinkRole = z.infer<typeof LinkRole>;

// ---------------------------------------------------------------- part

/**
 * A2A `Part`: exactly one of `text`, `url` (a file by reference) or `data` (any JSON value), plus
 * optional `mediaType`, `filename` and `metadata`. A2A's inline `raw` bytes are refused: a link
 * carries files by reference only (ADR 0022 §2 "file ref").
 */
export const LinkPart = z
  .object({
    text: z.string().max(200_000).optional(),
    url: Url.optional(),
    data: z.unknown().optional(),
    raw: z.never().optional(),
    mediaType: MediaType.optional(),
    filename: z.string().min(1).max(255).optional(),
    metadata: Metadata.optional(),
  })
  .refine((p) => [p.text, p.url, p.data].filter((x) => x !== undefined).length === 1, {
    message: "a part has exactly one of text, url or data",
  });
export type LinkPart = z.infer<typeof LinkPart>;

const Parts = z.array(LinkPart).min(1).max(64);

// ---------------------------------------------------------------- message, artifact, task

/** A2A `Message`: one unit of communication, optionally tied to a task and a context. */
export const LinkMessage = z.object({
  messageId: Id,
  contextId: Id.optional(),
  taskId: Id.optional(),
  role: LinkRole,
  parts: Parts,
  metadata: Metadata.optional(),
  extensions: z.array(Url).max(16).optional(),
  referenceTaskIds: z.array(Id).max(32).optional(),
});
export type LinkMessage = z.infer<typeof LinkMessage>;

/** A2A `Artifact`: an output of a task. `artifactId` is unique within its task. */
export const LinkArtifact = z.object({
  artifactId: Id,
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  parts: Parts,
  metadata: Metadata.optional(),
  extensions: z.array(Url).max(16).optional(),
});
export type LinkArtifact = z.infer<typeof LinkArtifact>;

/** A2A `TaskStatus`. `timestamp` is ISO 8601 (A2A's form, not Chalito's epoch ms). */
export const LinkTaskStatus = z.object({
  state: LinkTaskState,
  message: LinkMessage.optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
});
export type LinkTaskStatus = z.infer<typeof LinkTaskStatus>;

/**
 * A2A `Task`: the unit of work. In Chalito a session is one long-lived `contextId` and each prompt
 * is a task in it (ADR 0022 §2).
 */
export const LinkTask = z.object({
  id: Id,
  contextId: Id,
  status: LinkTaskStatus,
  history: z.array(LinkMessage).max(500).optional(),
  artifacts: z.array(LinkArtifact).max(64).optional(),
  metadata: Metadata.optional(),
});
export type LinkTask = z.infer<typeof LinkTask>;

/** A2A `TaskStatusUpdateEvent`. */
export const LinkStatusUpdate = z.object({
  taskId: Id,
  contextId: Id,
  status: LinkTaskStatus,
  metadata: Metadata.optional(),
});
export type LinkStatusUpdate = z.infer<typeof LinkStatusUpdate>;

/** A2A `TaskArtifactUpdateEvent`. `append`: add these parts to the artifact with the same id. */
export const LinkArtifactUpdate = z.object({
  taskId: Id,
  contextId: Id,
  artifact: LinkArtifact,
  append: z.boolean().optional(),
  lastChunk: z.boolean().optional(),
  metadata: Metadata.optional(),
});
export type LinkArtifactUpdate = z.infer<typeof LinkArtifactUpdate>;

/** A2A `StreamResponse`: exactly one of `task`, `message`, `statusUpdate` or `artifactUpdate`. */
export const LinkStreamResponse = z.union([
  z.object({ task: LinkTask }).strict(),
  z.object({ message: LinkMessage }).strict(),
  z.object({ statusUpdate: LinkStatusUpdate }).strict(),
  z.object({ artifactUpdate: LinkArtifactUpdate }).strict(),
]);
export type LinkStreamResponse = z.infer<typeof LinkStreamResponse>;

/** Chalito's versioned container for one link update (what Phase C carries in sealed commands). */
export const LinkUpdate = z.object({ v: z.literal(1), update: LinkStreamResponse }).strict();
export type LinkUpdate = z.infer<typeof LinkUpdate>;

// ---------------------------------------------------------------- agent card

const Scopes = z.record(z.string().max(200), z.string().max(500));

/** A2A `OAuthFlows`: exactly one flow. */
export const LinkOAuthFlows = z
  .object({
    authorizationCode: z
      .object({
        authorizationUrl: Url,
        tokenUrl: Url,
        refreshUrl: Url.optional(),
        scopes: Scopes,
        pkceRequired: z.boolean().optional(),
      })
      .optional(),
    clientCredentials: z.object({ tokenUrl: Url, refreshUrl: Url.optional(), scopes: Scopes }).optional(),
    deviceCode: z
      .object({ deviceAuthorizationUrl: Url, tokenUrl: Url, refreshUrl: Url.optional(), scopes: Scopes })
      .optional(),
    // Deprecated in OAuth 2.1 but still in A2A v1.0; accepted on read, never generated by Chalito.
    implicit: z.object({ authorizationUrl: Url, refreshUrl: Url.optional(), scopes: Scopes }).optional(),
    password: z.object({ tokenUrl: Url, refreshUrl: Url.optional(), scopes: Scopes }).optional(),
  })
  .refine((f) => Object.values(f).filter((x) => x !== undefined).length === 1, {
    message: "exactly one OAuth flow",
  });
export type LinkOAuthFlows = z.infer<typeof LinkOAuthFlows>;

const Desc = z.string().max(2000).optional();

/** A2A `SecurityScheme` (OpenAPI 3.2 style): exactly one scheme. */
export const LinkSecurityScheme = z
  .object({
    apiKeySecurityScheme: z
      .object({ description: Desc, location: z.enum(["query", "header", "cookie"]), name: z.string().min(1).max(200) })
      .optional(),
    httpAuthSecurityScheme: z
      .object({ description: Desc, scheme: z.string().min(1).max(50), bearerFormat: z.string().max(50).optional() })
      .optional(),
    oauth2SecurityScheme: z
      .object({ description: Desc, flows: LinkOAuthFlows, oauth2MetadataUrl: Url.optional() })
      .optional(),
    openIdConnectSecurityScheme: z.object({ description: Desc, openIdConnectUrl: Url }).optional(),
    mtlsSecurityScheme: z.object({ description: Desc }).optional(),
  })
  .refine((s) => Object.values(s).filter((x) => x !== undefined).length === 1, {
    message: "exactly one security scheme",
  });
export type LinkSecurityScheme = z.infer<typeof LinkSecurityScheme>;

/** A2A `SecurityRequirement`: scheme name → required scopes. */
export const LinkSecurityRequirement = z.object({
  // ProtoJSON omits an empty list, so `{ "schemes": { "key": {} } }` is "key, no scopes".
  schemes: z.record(z.string().min(1).max(100), z.object({ list: z.array(z.string().max(200)).max(32).optional() })),
});
export type LinkSecurityRequirement = z.infer<typeof LinkSecurityRequirement>;

/** A2A `AgentInterface`: where and how to reach the agent. */
export const AgentInterface = z.object({
  url: Url,
  protocolBinding: z.string().min(1).max(50),
  tenant: z.string().max(200).optional(),
  protocolVersion: z.string().regex(/^\d+\.\d+$/, "Major.Minor"),
});
export type AgentInterface = z.infer<typeof AgentInterface>;

/** A2A `AgentSkill`. */
export const AgentSkill = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1).max(60)).max(32),
  examples: z.array(z.string().max(500)).max(16).optional(),
  inputModes: z.array(MediaType).max(16).optional(),
  outputModes: z.array(MediaType).max(16).optional(),
  securityRequirements: z.array(LinkSecurityRequirement).max(8).optional(),
});
export type AgentSkill = z.infer<typeof AgentSkill>;

/** A2A `AgentCapabilities`. */
export const AgentCapabilities = z.object({
  streaming: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  extensions: z
    .array(
      z.object({
        uri: Url,
        description: Desc,
        required: z.boolean().optional(),
        params: Metadata.optional(),
      }),
    )
    .max(16)
    .optional(),
  extendedAgentCard: z.boolean().optional(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;

/**
 * A2A `AgentCard`: an agent's self-description. `supportedInterfaces` may be missing for a card
 * that is only used inside Chalito (no endpoint yet); Phase D fills it when the owner exposes the
 * agent. Like every repeated A2A field, an empty list is omitted (ProtoJSON's canonical form).
 * `signatures` (JWS) are accepted on read; Chalito doesn't sign cards in Phase B.
 */
export const AgentCard = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  supportedInterfaces: z.array(AgentInterface).max(8).optional(),
  provider: z.object({ url: Url, organization: z.string().min(1).max(200) }).optional(),
  version: z.string().min(1).max(50),
  documentationUrl: Url.optional(),
  capabilities: AgentCapabilities,
  securitySchemes: z.record(z.string().min(1).max(100), LinkSecurityScheme).optional(),
  securityRequirements: z.array(LinkSecurityRequirement).max(8).optional(),
  defaultInputModes: z.array(MediaType).min(1).max(16),
  defaultOutputModes: z.array(MediaType).min(1).max(16),
  skills: z.array(AgentSkill).max(32),
  signatures: z
    .array(z.object({ protected: z.string().min(1), signature: z.string().min(1), header: Metadata.optional() }))
    .max(4)
    .optional(),
  iconUrl: Url.optional(),
});
export type AgentCard = z.infer<typeof AgentCard>;

// ---------------------------------------------------------------- card from recipe

/**
 * Recipe kinds whose driver takes a prompt and runs it as a task (an agent protocol session).
 * Terminal, desktop-app and web-app drivers are screens or shells, not task-taking agents.
 */
export const LINKABLE_KINDS = [
  "claude-sdk",
  "codex",
  "acp",
  "chat-api",
  "a2a",
] as const satisfies readonly RecipeKind[];

export const isLinkableRecipe = (r: Pick<Recipe, "kinds" | "capabilities"> & { notConnectable?: unknown }): boolean =>
  !r.notConnectable &&
  r.capabilities.includes("sessions") &&
  r.kinds.some((k) => (LINKABLE_KINDS as readonly RecipeKind[]).includes(k));

/** Which of the linkable drivers runs the recipe's agent (the first linkable kind). */
const agentKind = (r: Pick<Recipe, "kinds">) =>
  r.kinds.find((k) => (LINKABLE_KINDS as readonly RecipeKind[]).includes(k)) as (typeof LINKABLE_KINDS)[number];

/** The skill id of a chat-api recipe's card (text in, text out; no tools of its own). */
export const CHAT_SKILL = "chat" as const;
/** The skill id of an a2a recipe's card (the remote agent's own card lists its real skills). */
export const REMOTE_AGENT_SKILL = "remote-agent" as const;

export interface AgentCardOptions {
  /** Where the agent is reachable (Phase D). Default: none (a card used only inside Chalito). */
  supportedInterfaces?: AgentInterface[];
  securitySchemes?: Record<string, LinkSecurityScheme>;
  securityRequirements?: LinkSecurityRequirement[];
  /** The card's version. Default "1". */
  version?: string;
}

/** The skill id every linkable recipe's card offers. */
export const CODING_SESSION_SKILL = "coding-session" as const;

/**
 * The A2A Agent Card for a recipe's agent (ADR 0022 §2: "generated from the recipe"), or `null`
 * when the recipe has no task-taking driver (see `LINKABLE_KINDS`). Pure data: the card names the
 * app and its vendor and never carries commands, paths, profiles or keys from the recipe.
 */
export const agentCardFromRecipe = (recipe: Recipe, opts: AgentCardOptions = {}): AgentCard | null => {
  if (!isLinkableRecipe(recipe)) return null;
  const id = AppId.parse(recipe.id);
  const kind = agentKind(recipe);
  const skill =
    kind === "chat-api"
      ? {
          id: CHAT_SKILL,
          name: "Chat",
          description: `Answers in text with ${recipe.name}, on the owner's own account. It has no tools unless the owner turns on Chalito's gated computer control, and then every risky action asks the owner.`,
          tags: ["chat", id],
        }
      : kind === "a2a"
        ? {
            id: REMOTE_AGENT_SKILL,
            name: "Remote agent",
            description: `Hands the task to ${recipe.name}, a remote A2A agent the owner connected. It runs on ${recipe.vendor}'s side, not on the owner's computer.`,
            tags: ["a2a", id],
          }
        : {
            id: CODING_SESSION_SKILL,
            name: "Coding session",
            description: `Works on a task in a repository with ${recipe.name}: reads and edits code and runs tools, with every risky tool gated by the owner's approval.`,
            tags: ["coding", id],
          };
  const description =
    kind === "chat-api"
      ? `${recipe.name} (${recipe.vendor}), a chat model Chalito reaches through its OpenAI-compatible API with the owner's own key.`
      : kind === "a2a"
        ? `${recipe.name} (${recipe.vendor}), a remote A2A agent connected through Chalito.`
        : `${recipe.name} (${recipe.vendor}), a coding agent run by Chalito on the owner's computer.`;
  return AgentCard.parse({
    name: recipe.name,
    description,
    ...(opts.supportedInterfaces?.length ? { supportedInterfaces: opts.supportedInterfaces } : {}),
    provider: { url: recipe.homepage, organization: recipe.vendor },
    version: opts.version ?? "1",
    documentationUrl: recipe.homepage,
    capabilities: { streaming: true, pushNotifications: false },
    ...(opts.securitySchemes ? { securitySchemes: opts.securitySchemes } : {}),
    ...(opts.securityRequirements ? { securityRequirements: opts.securityRequirements } : {}),
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [skill],
  });
};
