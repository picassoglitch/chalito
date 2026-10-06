import { z } from "zod";
import { AppId, RemoteCodexSandbox, RemotePermissionMode } from "@chalito/protocol";

/**
 * ~/.chalito/policy.yaml: the device's ceiling (ADR 0008). Remote surfaces can only
 * tighten it; loosening needs a local edit plus local confirmation.
 */
export const Workspace = z.object({
  label: z.string().min(1).max(60),
  path: z.string().min(1),
});

export const Policy = z.object({
  version: z.literal(1),
  /** No workspaces = nothing runs. Chosen by the user at setup. */
  workspaces: z.array(Workspace).default([]),
  /**
   * `grok` (Grok Build) and `gemini` (Gemini CLI) run over the ACP adapter. They are optional so
   * a policy written before they existed keeps its hash (the signed lock still verifies), and a
   * missing key means off: turning one on in an existing policy is a local edit, like any
   * loosening (ADR 0008).
   */
  adapters: z.object({
    claudeCode: z.boolean(),
    codex: z.boolean(),
    grok: z.boolean().optional(),
    gemini: z.boolean().optional(),
  }),
  remote: z.object({
    /** Highest Claude permission mode a remote surface may set. Never bypassPermissions. */
    maxPermissionMode: RemotePermissionMode,
    maxCodexSandbox: RemoteCodexSandbox,
  }),
  /** Prompt origins; each can be turned off. */
  origins: z.object({ local: z.boolean(), client: z.boolean(), mcp: z.boolean(), call: z.boolean() }),
  approvals: z.object({ ttlSeconds: z.number().int().min(30).max(600) }),
  /** Plaintext egress exceptions (opt-in). */
  egress: z.object({ callLines: z.boolean(), mcpCards: z.boolean() }),
  /** LOW-tier test/lint/build commands (prefix match on the normalised command). */
  allowlist: z.object({ commands: z.array(z.string().min(1)).default([]) }),
  web: z.object({ allowDomains: z.array(z.string().min(1)).default([]) }),
  mcp: z.object({ readOnlyTools: z.array(z.string().min(1)).default([]) }),
  /**
   * Computer control (screen, mouse, keyboard; apps/agent/src/computer). Absent = off, which is
   * also what every policy written before it reads as (no default here, so their hash and the
   * signed lock stay as they were). Turned on only by `chalito computer enable` or the desktop
   * panel (OS auth + confirmations); `chalito policy edit` and remote surfaces can only turn it
   * off or lower the rate.
   */
  computer: z
    .object({
      enabled: z.boolean(),
      /** Ceiling on screen/mouse/keyboard actions per session per minute (screenshots count). */
      maxActionsPerMinute: z.number().int().min(1).max(600),
    })
    .optional(),
  /**
   * Connect engine (apps/agent/src/apps). Absent = nothing set (policies written before it keep
   * their hash and the signed lock).
   * - `sessions`: an app id set to false can't start sessions here (remote surfaces may only turn
   *   one off); a curated app without an entry may, once it's connected. The four former providers
   *   keep `adapters.*`.
   * - `custom`: the person's own recipes enabled ON THIS COMPUTER, each with the sha256 of its
   *   file at enable time (an edited file is off until enabled again). Turned on only by
   *   `chalito apps custom enable` or the desktop panel (OS auth + confirmation); `chalito policy
   *   edit` and remote surfaces can only turn one off.
   */
  apps: z
    .object({
      sessions: z.record(AppId, z.boolean()).optional(),
      custom: z
        .record(AppId, z.object({ enabled: z.boolean(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict())
        .optional(),
    })
    .strict()
    .optional(),
  /**
   * Remote terminal (apps/agent/src/terminal): a trusted browser sees and types into a recipe's
   * terminal app in a PTY here. Absent = off (older policies keep their hash). Turned on only by
   * `chalito terminal enable` or the desktop panel (OS auth + confirmations); `rawShell` (appId
   * "shell", a full shell) only by `chalito terminal shell enable` or the panel, with its own
   * stronger confirmation. `chalito policy edit` and remote surfaces can only turn them off or
   * lower the limits.
   */
  remoteTerminal: z
    .object({
      enabled: z.boolean(),
      rawShell: z.boolean(),
      /** Terminals open (or waiting for approval) at once on this computer. */
      maxSessions: z.number().int().min(1).max(10),
      /** Ceiling on typed input per terminal per minute (UTF-16 code units). */
      maxInputPerMinute: z.number().int().min(256).max(1_048_576),
    })
    .optional(),
  /**
   * Remote screen (apps/agent/src/screen): a trusted browser sees (`view`) or also drives
   * (`control`) this screen over WebRTC. Absent = off (older policies keep their hash). Turned
   * on only by `chalito screen enable` or the desktop panel (OS auth + confirmations); remote
   * surfaces and `chalito policy edit` can only turn it off or lower the limits. `control`
   * implies `view`.
   */
  screen: z
    .object({
      view: z.boolean(),
      control: z.boolean(),
      /** Frames per second ceiling for the stream. */
      maxFps: z.number().int().min(1).max(15),
      /** Ceiling on clicks, keys and text messages per session per minute (pointer moves are coalesced). */
      maxInputsPerMinute: z.number().int().min(1).max(1200),
      /** A screen session ends after this long, approved again to continue. */
      maxSessionMinutes: z.number().int().min(1).max(240),
    })
    .optional(),
});
export type Policy = z.infer<typeof Policy>;

/** Beta defaults (brief §5 M3). */
export const DEFAULT_POLICY: Policy = {
  version: 1,
  workspaces: [],
  adapters: { claudeCode: true, codex: true, grok: true, gemini: true },
  remote: { maxPermissionMode: "acceptEdits", maxCodexSandbox: "workspace-write" },
  origins: { local: true, client: true, mcp: true, call: true },
  approvals: { ttlSeconds: 600 },
  egress: { callLines: true, mcpCards: false },
  allowlist: {
    commands: [
      "npm test",
      "npm run test",
      "npm run lint",
      "npm run build",
      "npm run typecheck",
      "pnpm test",
      "pnpm lint",
      "pnpm build",
      "pnpm typecheck",
      "pnpm run test",
      "pnpm run lint",
      "pnpm run build",
      "yarn test",
      "yarn lint",
      "yarn build",
      "npx vitest run",
      "npx tsc --noEmit",
      "cargo test",
      "cargo build",
      "cargo check",
      "go test",
      "go build",
      "go vet",
      "pytest",
      "make test",
    ],
  },
  web: { allowDomains: [] },
  mcp: { readOnlyTools: [] },
};

/** What `chalito screen enable` writes when the policy has no `screen` entry yet. */
export const DEFAULT_SCREEN = {
  view: false,
  control: false,
  maxFps: 5,
  maxInputsPerMinute: 600,
  maxSessionMinutes: 60,
} as const;

/** What `chalito computer enable` writes when the policy has no `computer` entry yet. */
export const DEFAULT_COMPUTER = { enabled: false, maxActionsPerMinute: 60 } as const;

/** What `chalito terminal enable` writes when the policy has no `remoteTerminal` entry yet. */
export const DEFAULT_REMOTE_TERMINAL = {
  enabled: false,
  rawShell: false,
  maxSessions: 3,
  maxInputPerMinute: 65_536,
} as const;

export const PERMISSION_RANK = { plan: 0, default: 1, acceptEdits: 2 } as const;
export const SANDBOX_RANK = { "read-only": 0, "workspace-write": 1 } as const;
