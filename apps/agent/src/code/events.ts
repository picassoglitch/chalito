import type { Origin, RiskTier, SessionState, ToolCategory } from "@chalito/protocol";

/** ADR 0031 §1: a session's events in plaintext, for the computer it runs on (never stored or sent). */
export type LocalEvent =
  | { type: "user"; origin: Origin; text: string }
  | { type: "delta"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; toolUseId: string; category: ToolCategory; risk: RiskTier; summary: string }
  | { type: "tool_done"; toolUseId: string; ok: boolean }
  | { type: "approval"; aid: string; risk: RiskTier; stepUp: boolean; summary: string }
  | { type: "approval_done"; aid: string; allow: boolean; reason: string }
  | { type: "state"; state: SessionState }
  | { type: "error"; code: string };

export type LocalTap = (sid: string, e: LocalEvent) => void;
