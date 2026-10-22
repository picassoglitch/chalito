import { z } from "zod";
import { DeviceId, RemotePermissionMode, SessionId } from "./common.js";
import { BranchName } from "./coord.js";
import { WorkspaceLabel } from "./presence.js";
import { AppId } from "./recipe.js";

// ---- Remote control (ADR 0031) ---------------------------------------------------------------

const ObjectId = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

// ADR 0031 §4: a git remote as `host/path` (no scheme, credentials, port or `.git`), so two
// computers can tell they hold the same project without sending credentials.
export const RepoRemote = z
  .string()
  .max(300)
  .regex(/^[a-z0-9.-]+\/[A-Za-z0-9._~/-]+$/);
export type RepoRemote = z.infer<typeof RepoRemote>;

/** `git@github.com:o/r.git`, `https://user:tok@GitHub.com/o/r.git`, `ssh://git@host:22/o/r` → `host/o/r`. */
export const normalizeRemote = (url: string): string | null => {
  const s = url.trim();
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(s);
  let host: string;
  let path: string;
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(u.protocol) || !u.hostname) return null;
    host = u.hostname;
    try {
      path = decodeURIComponent(u.pathname);
    } catch {
      // A bad percent-escape is not a remote we can compare.
      return null;
    }
  }
  path = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const out = `${host.toLowerCase()}/${path}`;
  return RepoRemote.safeParse(out).success && !path.split("/").includes("..") ? out : null;
};

// ADR 0031 §4: the one data part of a transfer hand-off. The brief is quoted data at the
// receiver, never instructions.
export const SessionTransfer = z
  .object({
    v: z.literal(1),
    kind: z.literal("chalito.transfer.v1"),
    fromSid: SessionId,
    appId: AppId,
    /** The session's own mode; the receiver starts at no more than this (and the link's ceiling). */
    permissionMode: RemotePermissionMode,
    title: z.string().max(200),
    /** The conversation so far as plain quoted text, newest last. */
    brief: z.string().max(32_000),
    /** Absent when the workspace isn't a git repo with an `origin`. */
    repo: z.object({ remote: RepoRemote, branch: BranchName, head: ObjectId }).strict().optional(),
  })
  .strict();
export type SessionTransfer = z.infer<typeof SessionTransfer>;

/** The receiver's immediate answer (the one data part of its `link.result`): the new session. */
export const SessionTransferAck = z
  .object({ v: z.literal(1), kind: z.literal("chalito.transfer.ack.v1"), sid: SessionId })
  .strict();
export type SessionTransferAck = z.infer<typeof SessionTransferAck>;

export const TransferStage = z.enum(["sent", "delivered", "refused"]);
export type TransferStage = z.infer<typeof TransferStage>;

/** Why a transfer didn't happen; a closed set, so no path or free text reaches the phone. */
export const TransferRefusal = z.enum([
  // Refused on the computer it was on (also its command.rejected reason).
  "busy",
  "no_link",
  "dirty",
  "unpushed",
  // Saving unfinished work on a branch for the move: the push was refused (auth) or failed.
  "push_auth",
  "push_failed",
  // Untracked files that look like secrets or dumps (their paths travel sealed, `ct`), git older than
  // 2.40 (can't keep filters off), and Git LFS files (would go up raw).
  "secret_files",
  "git_too_old",
  "lfs_files",
  /** The receiver didn't answer within the relay's lifetime. */
  "offline",
  /** The receiving computer's workspace isn't the same project (`origin` differs). */
  "wrong_repo",
  /** The link refused it (revoked, rate, budget, owner said no, policy). */
  "link_refused",
  /** The receiving computer couldn't start the AI there. */
  "start_failed",
]);
export type TransferRefusal = z.infer<typeof TransferRefusal>;

// ---- Routing rules (ADR 0031 §5) -------------------------------------------------------------

/** Where a new session runs when the owner doesn't pick: the first able computer of `devices`. */
export const RouteRule = z
  .object({
    workspaceLabel: WorkspaceLabel.optional(),
    appId: AppId.optional(),
    devices: z.array(DeviceId).min(1).max(3),
  })
  .strict();
export type RouteRule = z.infer<typeof RouteRule>;

/** Stored in the owner's settings (`prefs.routing`); kept small to fit there. */
export const ROUTE_RULES_MAX_BYTES = 3000;
export const RouteRules = z
  .object({
    v: z.literal(1),
    rules: z.array(RouteRule).max(8),
    fallback: z.array(DeviceId).max(6),
  })
  .strict()
  .refine((r) => new TextEncoder().encode(JSON.stringify(r)).length <= ROUTE_RULES_MAX_BYTES, {
    message: `routing rules are at most ${ROUTE_RULES_MAX_BYTES} bytes`,
  });
export type RouteRules = z.infer<typeof RouteRules>;

/** One of the owner's computers as the client sees it (live store + `presence.setup`). */
export interface RouteComputer {
  deviceId: string;
  online: boolean;
  /** App ids ready there; empty when it reported nothing. */
  adapters: readonly string[];
  /** Workspace labels it reported (at most 20). */
  labels: readonly string[];
  /** How many workspaces it has; above `labels.length` the list was cut, so a label may still be there. */
  workspaces: number;
}

export type RouteChoice =
  | {
      ok: true;
      deviceId: string;
      appId: string;
      workspaceLabel: string;
      via: "rule" | "fallback" | "any";
      /** The index of the rule that chose it (`via: "rule"`). */
      rule?: number;
    }
  | { ok: false; reason: "no_computer" };

// ADR 0031 §5: rules in order (a set field must match or is filled in), then fallback, then any
// computer that is online and has the app and the workspace.
export const resolveRoute = (
  rules: RouteRules | null,
  want: { workspaceLabel?: string; appId?: string },
  computers: readonly RouteComputer[],
): RouteChoice => {
  const byId = new Map(computers.map((c) => [c.deviceId, c]));
  const pick = (c: RouteComputer | undefined, appId: string | undefined, label: string | undefined) => {
    if (!c || !c.online) return null;
    const app = appId ?? c.adapters[0];
    if (!app || !c.adapters.includes(app)) return null;
    const ws = label ?? (c.workspaces === 1 && c.labels.length === 1 ? c.labels[0] : undefined);
    if (!ws) return null;
    if (!c.labels.includes(ws) && c.workspaces <= c.labels.length) return null;
    return { deviceId: c.deviceId, appId: app, workspaceLabel: ws };
  };
  const list = rules?.rules ?? [];
  for (const [i, r] of list.entries()) {
    if (r.workspaceLabel !== undefined && want.workspaceLabel !== undefined && r.workspaceLabel !== want.workspaceLabel)
      continue;
    if (r.appId !== undefined && want.appId !== undefined && r.appId !== want.appId) continue;
    const appId = want.appId ?? r.appId;
    const label = want.workspaceLabel ?? r.workspaceLabel;
    for (const d of r.devices) {
      const p = pick(byId.get(d), appId, label);
      if (p) return { ok: true, ...p, via: "rule", rule: i };
    }
  }
  const tried = new Set<string>();
  for (const d of rules?.fallback ?? []) {
    tried.add(d);
    const p = pick(byId.get(d), want.appId, want.workspaceLabel);
    if (p) return { ok: true, ...p, via: "fallback" };
  }
  for (const c of computers) {
    if (tried.has(c.deviceId)) continue;
    const p = pick(c, want.appId, want.workspaceLabel);
    if (p) return { ok: true, ...p, via: "any" };
  }
  return { ok: false, reason: "no_computer" };
};
