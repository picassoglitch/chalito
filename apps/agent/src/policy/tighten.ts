import { resolve, sep } from "node:path";
import type { PolicyPreset } from "@chalito/protocol";
import type { z } from "zod";
import { DEFAULT_REMOTE_TERMINAL, PERMISSION_RANK, Policy, SANDBOX_RANK } from "./schema.js";

const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const subsetOf = (a: string[], b: string[]) => a.every((x) => b.includes(x));
const flagsOnlyOff = <T extends Record<string, boolean | undefined>>(next: T, cur: T) =>
  Object.keys(next).every((k) => !next[k] || cur[k]);

/** True when `next` grants nothing that `cur` doesn't: the only kind of change a remote surface may make. */
export const isTighterOrEqual = (next: Policy, cur: Policy): boolean =>
  next.workspaces.every((w) => cur.workspaces.some((c) => within(resolve(w.path), resolve(c.path)))) &&
  flagsOnlyOff(next.adapters, cur.adapters) &&
  PERMISSION_RANK[next.remote.maxPermissionMode] <= PERMISSION_RANK[cur.remote.maxPermissionMode] &&
  SANDBOX_RANK[next.remote.maxCodexSandbox] <= SANDBOX_RANK[cur.remote.maxCodexSandbox] &&
  flagsOnlyOff(next.origins, cur.origins) &&
  flagsOnlyOff(next.egress, cur.egress) &&
  next.approvals.ttlSeconds <= cur.approvals.ttlSeconds &&
  subsetOf(next.allowlist.commands, cur.allowlist.commands) &&
  subsetOf(next.web.allowDomains, cur.web.allowDomains) &&
  subsetOf(next.mcp.readOnlyTools, cur.mcp.readOnlyTools) &&
  computerTighterOrEqual(next.computer, cur.computer) &&
  remoteTerminalTighterOrEqual(next.remoteTerminal, cur.remoteTerminal);

/** Computer control can only be turned off or slowed down; never on (that's `chalito computer enable`). */
export const computerTighterOrEqual = (next: Policy["computer"], cur: Policy["computer"]): boolean =>
  !next?.enabled || (!!cur?.enabled && next.maxActionsPerMinute <= cur.maxActionsPerMinute);

/**
 * Remote terminal and the raw shell can only be turned off or limited further; never on (that's
 * `chalito terminal enable` / `chalito terminal shell enable`, local only). The raw-shell flag
 * and the limits can't grow even while remote terminal is off, so nothing staged remotely comes
 * back when the person turns it on (that path also resets `rawShell` to off).
 */
export const remoteTerminalTighterOrEqual = (
  next: Policy["remoteTerminal"],
  cur: Policy["remoteTerminal"],
): boolean => {
  if (!next) return true;
  const base = cur ?? DEFAULT_REMOTE_TERMINAL;
  return (
    (!next.enabled || !!cur?.enabled) &&
    (!next.rawShell || !!cur?.rawShell) &&
    next.maxSessions <= base.maxSessions &&
    next.maxInputPerMinute <= base.maxInputPerMinute
  );
};

export type TightenResult = { ok: true; policy: Policy } | { ok: false; reason: "invalid_patch" | "would_loosen" };

/**
 * Applies a remote patch (shallow per section) only if the result is a subset of the
 * current policy. Loosening is possible only by editing the file locally.
 */
export const applyRemoteTighten = (cur: Policy, patch: unknown): TightenResult => {
  if (!patch || typeof patch !== "object") return { ok: false, reason: "invalid_patch" };
  const merged: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const prev = (cur as Record<string, unknown>)[k];
    merged[k] =
      v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" ? { ...prev, ...v } : v;
  }
  const parsed = Policy.safeParse(merged);
  if (!parsed.success) return { ok: false, reason: "invalid_patch" };
  return isTighterOrEqual(parsed.data, cur) ? { ok: true, policy: parsed.data } : { ok: false, reason: "would_loosen" };
};

/**
 * Cloud presets (Estricto / Estándar / Relajado) only change remote-facing settings,
 * and apply only after local acceptance on the device.
 */
export const presetPolicy = (preset: z.infer<typeof PolicyPreset>, cur: Policy): Policy => {
  switch (preset) {
    case "estricto":
      return {
        ...cur,
        remote: { maxPermissionMode: "default", maxCodexSandbox: "read-only" },
        origins: { ...cur.origins, mcp: false, call: false },
        egress: { callLines: false, mcpCards: false },
      };
    case "estandar":
      return {
        ...cur,
        remote: { maxPermissionMode: "acceptEdits", maxCodexSandbox: "workspace-write" },
        origins: { local: true, client: true, mcp: true, call: true },
        egress: { ...cur.egress, mcpCards: false },
      };
    case "relajado":
      return {
        ...cur,
        remote: { maxPermissionMode: "acceptEdits", maxCodexSandbox: "workspace-write" },
        origins: { local: true, client: true, mcp: true, call: true },
      };
  }
};
