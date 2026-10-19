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
  Signature,
  Uid,
} from "./common.js";
import { LINK_RELAY_TYPES, LinkCommands, LinkId, LinkRelayCommands } from "./agent-link.js";
import { CoordCommands } from "./coord.js";
import { StepUp } from "./approval.js";
import { SealedEnvelope, signed } from "./crypto.js";
import { ProviderConnectMethod } from "./provider.js";
import { AppId } from "./recipe.js";
import { TerminalCommands } from "./terminal.js";
import { ScreenMode } from "./screen.js";

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
 * Remote screen follows the same rule: `screen.open` only asks; it never enables remote view or
 * control, which are turned on only on the device (`chalito screen enable`).
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
    /**
     * ADR 0022 §4 (M16 F): a hand-off task from outside (MCP `create_task`, A2A `SendMessage`) over a
     * link set to "ask me each time". The agent asks the owner first (`link_handoff` approval, one
     * tap) and starts the session only on a signed yes; a no or no answer rejects it. It can only
     * add that step, never skip one.
     */
    linkConfirm: z.object({ linkId: LinkId }).strict().optional(),
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

  // ---- SCREEN (remote view / control; screen.ts) --------------------------------------------
  // Refused unless the person enabled remote view (or control) on the device itself. Each
  // session waits for a `remote_view` / `remote_control` approval (HIGH, passkey) before any
  // capture; frames and input then go peer-to-peer over WebRTC, never through the cloud.
  /**
   * Opens a screen session. `display` is a display index ("0" = primary); `appId` (a recipe id)
   * launches or focuses that app (or its managed browser profile) before streaming starts.
   */
  z.object({
    type: z.literal("screen.open"),
    mode: ScreenMode,
    display: z
      .string()
      .regex(/^[0-9]{1,2}$/)
      .optional(),
    appId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,40}$/)
      .optional(),
  }),
  /** Ends a screen session (either end may; the agent also ends it on kill switch / disable). */
  z.object({ type: z.literal("screen.close"), sid: SessionId }),
  /** The browser's WebRTC answer / ICE candidate, sealed to the device (`ScreenSignal`). */
  z.object({ type: z.literal("screen.signal"), sid: SessionId, signalCt: SealedEnvelope }),
  // ---- end SCREEN ---------------------------------------------------------------------------

  // ---- LINKS (agent-to-agent, ADR 0022 §3; agent-link.ts) ------------------------------------
  // A client can make share links only (with step-up), and revoke or list any link. The relay
  // payloads come only from another agent over a link (RelayedCommand, relayedBy agent-link).
  ...LinkCommands,
  ...LinkRelayCommands,
  // ---- end LINKS ------------------------------------------------------------------------------

  // ---- COORDINATOR (ADR 0025 §6; coord/coordinator.ts) ---------------------------------------
  // Client-signed only: no relay carries a coord.* payload (RelayedCommand below), and
  // `coord.merge` also needs the signer's passkey step-up over this command (the agent checks).
  ...CoordCommands,
  // ---- end COORDINATOR ------------------------------------------------------------------------
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
  })
  // ADR 0022 §3: an `agent:*` origin carries the link relay payloads and nothing else, and only
  // it carries them (a client can't sign a hand-off, an agent can't send anything else).
  .refine((b) => (LINK_RELAY_TYPES as readonly string[]).includes(b.payload.type) === b.origin.startsWith("agent:"), {
    message: "link.handoff / link.share / link.result come only from an agent:* origin, and only they do",
  });
export type CommandBody = z.infer<typeof CommandBody>;

/** A command signed by a trusted client (origin `client:<id>`). */
export const SignedCommand = signed("chalito.command.v1", CommandBody);
export type SignedCommand = z.infer<typeof SignedCommand>;

/**
 * A command relayed on behalf of an unsigned origin: by the cloud (`mcp:*`, `call:*`, `a2a:*`),
 * or by another of the owner's agents over a link (`agent:*`, ADR 0022 §3).
 * The cloud relays are restricted to prompting (and hand-off starts); the agent applies its
 * origin policy and never
 * Developer-mode auto-approve to the resulting turn.
 * An `agent-link` relay carries only the link payloads, and is signed by the sending agent's
 * device key (`chalito.link.v1`, `signerDeviceId` + `sig`). The receiver verifies it against the
 * key it recorded locally for that link, never against a key from the cloud. A person's key never
 * signs it, so its turns are never `isSignedOrigin`.
 */
export const RelayedCommand = z
  .object({
    relayedBy: z.enum(["mcp-gateway", "notifier", "a2a-server", "agent-link"]),
    body: CommandBody,
    signerDeviceId: DeviceId.optional(),
    sig: Signature.optional(),
  })
  // Each relay carries only its own origin (review R-L2): the MCP gateway relays `mcp:*` prompts,
  // the notifier relays `call:*` prompts (a spoken answer becomes a prompt), and an agent relays
  // `agent:*` link payloads. Nothing relays a session.answer, and a relay can't carry a step-up.
  //
  // ADR 0022 §4 (M16 D, D-071): a hand-off task (`create_task` on the MCP gateway, an A2A
  // `SendMessage` on the A2A server) is a `session.start`, relayed only after a LinkAuthorizer
  // allowed it. A relayed start never asks for more than the default permission mode (no
  // acceptEdits, no Codex sandbox): the device's ceiling and gate still apply on top.
  .refine(
    ({ relayedBy, body, signerDeviceId, sig }) => {
      if (body.stepUp !== undefined) return false;
      if (relayedBy === "agent-link")
        return (
          body.origin.startsWith("agent:") &&
          (LINK_RELAY_TYPES as readonly string[]).includes(body.payload.type) &&
          signerDeviceId !== undefined &&
          sig !== undefined
        );
      if (signerDeviceId !== undefined || sig !== undefined) return false;
      const own =
        relayedBy === "mcp-gateway"
          ? body.origin.startsWith("mcp:")
          : relayedBy === "a2a-server"
            ? body.origin.startsWith("a2a:")
            : body.origin.startsWith("call:");
      const p = body.payload;
      const kind =
        relayedBy === "a2a-server"
          ? p.type === "session.start"
          : relayedBy === "mcp-gateway"
            ? p.type === "session.prompt" || p.type === "session.start"
            : p.type === "session.prompt";
      const tame = p.type !== "session.start" || (p.permissionMode !== "acceptEdits" && p.codexSandbox === undefined);
      return own && kind && tame;
    },
    {
      message:
        "relays carry only their own origin and payloads (mcp-gateway: mcp:* session.prompt or a default/plan session.start for hand-offs, notifier: call:* session.prompt, a2a-server: a2a:* default/plan session.start, agent-link: signed agent:* link.*)",
    },
  );
export type RelayedCommand = z.infer<typeof RelayedCommand>;

export const CommandEnvelope = z.union([SignedCommand, RelayedCommand]);
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;
