import { z } from "zod";
import {
  AdapterKind,
  DeviceId,
  EpochMs,
  Id,
  Origin,
  Provider,
  RemoteCodexSandbox,
  RemotePermissionMode,
  ReplayNonce,
  SessionId,
  Uid,
} from "./common.js";
import { StepUp } from "./approval.js";
import { SealedEnvelope, signed } from "./crypto.js";
import { ProviderConnectMethod } from "./provider.js";
import { AppId } from "./recipe.js";
import { TerminalCommands } from "./terminal.js";

/** Developer-mode toggles. They can be turned ON only locally on the device. */
export const DevModeToggle = z.enum(["allowSudo", "autoApproveHigh", "autoApproveCritical", "bypassStyle"]);
export type DevModeToggle = z.infer<typeof DevModeToggle>;
/**
 * The toggles a person may turn ON locally (CLI or desktop panel, OS auth + three confirmations).
 * `bypassStyle` can only be turned off.
 */
export const EnableableDevModeToggle = z.enum(["allowSudo", "autoApproveHigh", "autoApproveCritical"]);
export type EnableableDevModeToggle = z.infer<typeof EnableableDevModeToggle>;

/** Policy presets proposed from the cloud; they take effect only after acceptance on the device. */
export const PolicyPreset = z.enum(["estricto", "estandar", "relajado"]);

/**
 * Connect a provider on the device. With `api_key` the key travels only sealed to the device
 * (`keyCt`, never plaintext on the wire) and lands in its OS keychain. With `signin` the device
 * runs the provider's own official sign-in (it opens the browser on that computer), if
 * providers.yaml `subscriptionLocal` allows it for this person.
 */
const ProviderConnect = z
  .object({
    type: z.literal("provider.connect"),
    provider: Provider,
    method: ProviderConnectMethod,
    keyCt: SealedEnvelope.optional(),
  })
  .refine((p) => (p.method === "api_key") === (p.keyCt !== undefined), {
    message: "keyCt is required with api_key and refused with signin",
  });

/**
 * Commands a remote surface can send to a device agent. There is no command that
 * enables Developer mode, enables a toggle, loosens policy, adds a trusted client,
 * enables computer control, or sets a permission mode above `acceptEdits` — those
 * shapes are unrepresentable. The provider.* commands manage credentials and the
 * provider's CLI only; they never touch policy. (Computer control is turned on only on the
 * device, `chalito computer enable` or the desktop panel; a remote surface can turn it off
 * through `policy.tighten` and approve or deny a session's `computer_control` approval.)
 * The app.* commands (engine) act on recipes only: none of them enables a custom recipe, which
 * happens only on the device (`chalito apps custom enable` or the desktop panel).
 * The terminal.* commands open, feed, resize and close a remote terminal only after the
 * person turned remote terminal on locally and approved that terminal (terminal.ts); nothing
 * here can turn remote terminal or the raw shell on.
 */
// ---- ENGINE (connect engine, contract v2): the app.* commands --------------------------------
/**
 * `app.connect`: like provider.connect, for any recipe (curated, or a custom one already enabled
 * on the device). A sign-in is always the app's own, on that computer.
 */
const AppConnect = z
  .object({
    type: z.literal("app.connect"),
    appId: AppId,
    method: ProviderConnectMethod,
    keyCt: SealedEnvelope.optional(),
  })
  .refine((p) => (p.method === "api_key") === (p.keyCt !== undefined), {
    message: "keyCt is required with api_key and refused with signin",
  });
const AppCommands = [
  AppConnect,
  /** Deletes the key, or signs out of the profile Chalito uses for this app. */
  z.object({ type: z.literal("app.disconnect"), appId: AppId }),
  /** Official source only, and only after the person confirms it on the device itself. */
  z.object({ type: z.literal("app.install"), appId: AppId }),
  /** A fresh status report for one app, or all of them. */
  z.object({ type: z.literal("app.status"), appId: AppId.optional() }),
  /** Opens a desktop or web app on that computer (its window, or its managed browser profile). */
  z.object({ type: z.literal("app.launch"), appId: AppId }),
] as const;
// ---- end ENGINE ----------------------------------------------------------------------------

/**
 * `session.start` names what to run by `appId` (a recipe id, engine contract v2) or by the older
 * `adapter`; with both, they must agree (the agent checks). At least one is required.
 */
const SessionStart = z
  .object({
    type: z.literal("session.start"),
    adapter: AdapterKind.optional(),
    appId: AppId.optional(),
    /** Label of a workspace the user allowed locally; never a raw path. */
    workspaceLabel: z.string().min(1).max(80),
    promptCt: SealedEnvelope,
    permissionMode: RemotePermissionMode.default("default"),
    codexSandbox: RemoteCodexSandbox.optional(),
  })
  .refine((p) => p.adapter !== undefined || p.appId !== undefined, { message: "adapter or appId is required" });

export const CommandPayload = z.discriminatedUnion("type", [
  SessionStart,
  z.object({ type: z.literal("session.prompt"), sid: SessionId, promptCt: SealedEnvelope }),
  z.object({ type: z.literal("session.interrupt"), sid: SessionId }),
  z.object({ type: z.literal("session.resume"), sid: SessionId, promptCt: SealedEnvelope.optional() }),
  z.object({
    type: z.literal("session.setPermissionMode"),
    sid: SessionId,
    permissionMode: RemotePermissionMode,
    codexSandbox: RemoteCodexSandbox.optional(),
  }),
  /** Answer to an agent question (AskUserQuestion / Codex user input). Not an approval. */
  z.object({ type: z.literal("session.answer"), sid: SessionId, questionId: Id, answerCt: SealedEnvelope }),
  /** Tightening only: the agent applies it if the resulting policy is a subset of the current one. */
  z.object({ type: z.literal("policy.tighten"), patchCt: SealedEnvelope }),
  /** Proposal only: shown on the device, applied after local acceptance. */
  z.object({ type: z.literal("policy.proposePreset"), preset: PolicyPreset }),
  z.object({ type: z.literal("devmode.off") }),
  z.object({ type: z.literal("devmode.toggleOff"), toggle: DevModeToggle }),
  z.object({ type: z.literal("device.revokeClient"), clientDeviceId: DeviceId }),
  ProviderConnect,
  /** Deletes the key, or signs out the CLI profile Chalito uses for this provider. */
  z.object({ type: z.literal("provider.disconnect"), provider: Provider }),
  /** Official installer only, and only after the person confirms it on the device itself. */
  z.object({ type: z.literal("provider.install"), provider: Provider }),
  /** Asks the device for a fresh status report (chalito.connections). */
  z.object({ type: z.literal("provider.status") }),
  ...AppCommands,
  // ---- TERMINAL (Connect engine, remote terminal; packages/protocol/src/terminal.ts) ----
  ...TerminalCommands,
  // ---- end TERMINAL ----
]);
export type CommandPayload = z.infer<typeof CommandPayload>;

/** Commands live at most 10 minutes, so the nonce window the agent must remember is bounded. */
export const COMMAND_TTL_MS = 10 * 60 * 1000;

export const CommandBody = z
  .object({
    v: z.literal(1),
    cid: Id,
    uid: Uid,
    targetDeviceId: DeviceId,
    origin: Origin,
    nonce: ReplayNonce,
    issuedAt: EpochMs,
    expiresAt: EpochMs,
    payload: CommandPayload,
    /**
     * A passkey assertion over SHA-256(JCS(this body without stepUp)), like a Decision's. Required
     * by agents to revoke ANOTHER client while any trusted client has a passkey (review R-L1).
     */
    stepUp: StepUp.optional(),
  })
  // Upper bound only: an already-expired command still parses, so the agent can reject it as "expired".
  .refine((b) => b.expiresAt - b.issuedAt <= COMMAND_TTL_MS, {
    message: "commands expire within 10 minutes of being issued",
  })
  // ADR 0020: a bundle step-up (revoke-all) authorizes revokes only.
  .refine((b) => b.stepUp?.bundle === undefined || b.payload.type === "device.revokeClient", {
    message: "a bundle step-up only covers device.revokeClient",
  });
export type CommandBody = z.infer<typeof CommandBody>;

/** A command signed by a trusted client (origin `client:<id>`). */
export const SignedCommand = signed("chalito.command.v1", CommandBody);
export type SignedCommand = z.infer<typeof SignedCommand>;

/**
 * A command relayed by the cloud on behalf of an unsigned origin (`mcp:*`, `call:*`).
 * Restricted to prompting/answering; the agent applies its origin policy and never
 * Developer-mode auto-approve to the resulting turn.
 */
export const RelayedCommand = z
  .object({
    relayedBy: z.enum(["mcp-gateway", "notifier"]),
    body: CommandBody,
  })
  // Each relay carries only its own origin (review R-L2): the MCP gateway relays `mcp:*` prompts,
  // the notifier relays `call:*` prompts (a spoken answer becomes a prompt). Nothing relays a
  // session.answer, and an unsigned relay can't carry a step-up.
  .refine(
    ({ relayedBy, body }) =>
      (relayedBy === "mcp-gateway" ? body.origin.startsWith("mcp:") : body.origin.startsWith("call:")) &&
      body.payload.type === "session.prompt" &&
      body.stepUp === undefined,
    { message: "relays carry only session.prompt from their own origin (mcp-gateway: mcp:*, notifier: call:*)" },
  );
export type RelayedCommand = z.infer<typeof RelayedCommand>;

export const CommandEnvelope = z.union([SignedCommand, RelayedCommand]);
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;
