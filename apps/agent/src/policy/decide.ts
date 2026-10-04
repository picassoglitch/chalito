import { isSignedOrigin, type DevModeToggle, type Origin, type RemotePermissionMode } from "@chalito/protocol";
import type { Classification } from "./classify.js";

export interface DevModeState {
  on: boolean;
  toggles: DevModeToggle[];
  since: number | null;
}

export const DEVMODE_OFF: DevModeState = { on: false, toggles: [], since: null };

export type GateDecision =
  | { action: "allow"; via: "policy_auto_allow" | "devmode_auto_allow" | "accept_edits" }
  | { action: "ask"; stepUp: boolean }
  | { action: "deny"; reason: "policy_block" | "hard_floor" | "no_workspace" | "origin_disabled" | "plan_mode" };

export interface DecideInput {
  classification: Classification;
  origin: Origin;
  /** Origins the local policy allows (unsigned ones can be turned off). */
  originAllowed: boolean;
  devMode: DevModeState;
  permissionMode: RemotePermissionMode | "local_only";
}

/**
 * Turns a classification into allow / ask / deny. Developer-mode auto-approve applies
 * only to signed origins (local, client:*), never to mcp:* or call:* turns, and never
 * past the hard floor.
 */
export const decide = ({
  classification: c,
  origin,
  originAllowed,
  devMode,
  permissionMode,
}: DecideInput): GateDecision => {
  if (c.noWorkspace) return { action: "deny", reason: "no_workspace" };
  if (c.hardFloor) return { action: "deny", reason: "hard_floor" };
  if (!originAllowed) return { action: "deny", reason: "origin_disabled" };

  const signed = isSignedOrigin(origin);
  const has = (t: DevModeToggle) => devMode.on && signed && devMode.toggles.includes(t);

  if (permissionMode === "plan" && c.tier !== "LOW") return { action: "deny", reason: "plan_mode" };

  switch (c.tier) {
    case "LOW":
      return { action: "allow", via: "policy_auto_allow" };
    case "MED":
      if (permissionMode === "acceptEdits" && c.workspaceEdit) return { action: "allow", via: "accept_edits" };
      return { action: "ask", stepUp: false };
    case "HIGH":
      if (has("autoApproveHigh")) return { action: "allow", via: "devmode_auto_allow" };
      return { action: "ask", stepUp: true };
    case "CRITICAL":
      if (c.sudo) {
        if (!has("allowSudo")) return { action: "deny", reason: "policy_block" };
        return has("autoApproveCritical")
          ? { action: "allow", via: "devmode_auto_allow" }
          : { action: "ask", stepUp: true };
      }
      if (has("autoApproveCritical")) return { action: "allow", via: "devmode_auto_allow" };
      return { action: "deny", reason: "policy_block" };
  }
};

/** Whether the policy allows prompts from this origin at all. */
export const originAllowed = (
  origins: { local: boolean; client: boolean; mcp: boolean; call: boolean },
  origin: Origin,
) =>
  origin === "local"
    ? origins.local
    : origin.startsWith("client:")
      ? origins.client
      : origin.startsWith("mcp:")
        ? origins.mcp
        : origins.call;
