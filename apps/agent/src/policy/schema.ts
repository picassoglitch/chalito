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
  adapters: z.object({ claudeCode: z.boolean(), codex: z.boolean() }),
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
});
export type Policy = z.infer<typeof Policy>;

/** Beta defaults (brief §5 M3). */
export const DEFAULT_POLICY: Policy = {
  version: 1,
  workspaces: [],
  adapters: { claudeCode: true, codex: true },
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

export const PERMISSION_RANK = { plan: 0, default: 1, acceptEdits: 2 } as const;
export const SANDBOX_RANK = { "read-only": 0, "workspace-write": 1 } as const;
