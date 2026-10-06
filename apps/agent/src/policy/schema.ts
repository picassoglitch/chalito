import { z } from "zod";
import { RemoteCodexSandbox, RemotePermissionMode } from "@chalito/protocol";

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

/** What `chalito computer enable` writes when the policy has no `computer` entry yet. */
export const DEFAULT_COMPUTER = { enabled: false, maxActionsPerMinute: 60 } as const;

export const PERMISSION_RANK = { plan: 0, default: 1, acceptEdits: 2 } as const;
export const SANDBOX_RANK = { "read-only": 0, "workspace-write": 1 } as const;
