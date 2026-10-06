import { z } from "zod";
import { SessionId } from "./common.js";
import { SealedEnvelope } from "./crypto.js";

/**
 * Remote terminal (Connect engine, contract v2 §2): a trusted browser sees and types into a
 * terminal app (aider, opencode, any CLI AI) running in a PTY on the device.
 *
 * - Turned on only on the device (`policy.remoteTerminal`, `chalito terminal enable` or the
 *   desktop panel). The raw shell is a separate, stronger local toggle (`rawShell`, appId
 *   "shell"). No command here, or anywhere, turns either on.
 * - Each terminal asks for a `terminal` approval (HIGH, passkey step-up) on a trusted device
 *   before anything runs, shows the desktop's on-screen indicator while open, and stops with the
 *   computer-control kill switch (Ctrl+Alt+Esc, tray "Detener control").
 * - Bytes travel only sealed. Input: `terminal.input.dataCt` is a SealedEnvelope to the device
 *   over JSON `TerminalData` with AAD `command:<cid>` (as every command ciphertext). Output:
 *   `terminal.output.dataCt` is sealed to the trusted clients over `TerminalData` with AAD
 *   `terminal:<tid>:<seq>`, so the relay can't reorder, replay or move chunks between terminals.
 *
 * The terminal id `tid` is a session id: the terminal is a session row (`kind: "terminal"`) and
 * its events use `sid = tid`.
 */

/** A recipe id (Connect engine recipes): kebab-case. "shell" is the raw shell. */
export const AppId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "appId must be a recipe id (kebab-case)");
export type AppId = z.infer<typeof AppId>;

/** The raw shell's app id: only with the local `rawShell` toggle on. */
export const RAW_SHELL_APP_ID = "shell";

export const TerminalId = SessionId;

export const TerminalCols = z.number().int().min(2).max(500);
export const TerminalRows = z.number().int().min(1).max(200);

/** Longest `TerminalData.data` one `terminal.input` may carry (UTF-16 code units). */
export const TERMINAL_INPUT_MAX = 4096;
/** Longest `TerminalData.data` one `terminal.output` carries (UTF-16 code units). */
export const TERMINAL_OUTPUT_CHUNK_MAX = 16 * 1024;

/** The plaintext inside `dataCt` (both directions). */
export const TerminalData = z.object({ data: z.string() });
export type TerminalData = z.infer<typeof TerminalData>;

/** Upper bound on an input ciphertext: TERMINAL_INPUT_MAX chars of UTF-8 (≤ 3 bytes each, JSON-escaped ≤ 6) in base64. */
const InputCt = SealedEnvelope.refine((e) => e.ct.length <= 40_000, { message: "terminal input too large" });

/** Commands (packages/protocol/src/command.ts adds them to `CommandPayload`). */
export const TerminalCommands = [
  /** Runs that recipe's terminal driver in the workspace; "shell" only with `rawShell` on. */
  z.object({
    type: z.literal("terminal.open"),
    appId: AppId,
    /** Label of a workspace the person allowed locally; never a raw path. */
    workspaceLabel: z.string().min(1).max(80),
    /** Optional (no default: a default would change the signed body); the agent uses 80×24. */
    cols: TerminalCols.optional(),
    rows: TerminalRows.optional(),
  }),
  z.object({ type: z.literal("terminal.input"), tid: TerminalId, dataCt: InputCt }),
  z.object({ type: z.literal("terminal.resize"), tid: TerminalId, cols: TerminalCols, rows: TerminalRows }),
  z.object({ type: z.literal("terminal.close"), tid: TerminalId }),
] as const;

/** Why a terminal ended (`terminal.closed`). */
export const TerminalCloseReason = z.enum([
  /** The program exited by itself (`exitCode`). */
  "exited",
  /** `terminal.close` from a trusted client. */
  "closed",
  /** The person denied the approval, or it expired. */
  "denied",
  /** The kill switch (hotkey, tray, indicator, panel, CLI) or the agent stopping. */
  "killed",
  /** Remote terminal (or the raw shell) was turned off. */
  "disabled",
  /** The desktop app stopped showing the on-screen indicator. */
  "indicator",
  /** The PTY couldn't start. */
  "failed",
]);
export type TerminalCloseReason = z.infer<typeof TerminalCloseReason>;
