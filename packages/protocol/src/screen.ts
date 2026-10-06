import { z } from "zod";
import { DeviceId, EpochMs, SessionId } from "./common.js";
import { signed } from "./crypto.js";

/**
 * Remote screen (view / control) between a trusted client's browser and a device (engine
 * contract §2 SCREEN, docs/adr/0021-remote-screen.md).
 *
 * - Turned on ONLY on the device (`chalito screen enable`, or the desktop panel: OS auth +
 *   confirmations). No command can turn it on; `policy.tighten` can only turn it off.
 * - `screen.open` asks the person for a per-session `remote_view` or `remote_control` approval
 *   (HIGH, passkey step-up) on a trusted device before anything is captured.
 * - Frames and input travel over a WebRTC peer connection (DTLS) between the browser and the
 *   device. The cloud only carries the signaling, which is signed by the sender and sealed to the
 *   two ends: offers and ICE from the agent are agent-signed and sealed to the requesting client
 *   only; the browser's answer comes back as a signed, sealed `screen.signal` command.
 * - Input exists only in `control` mode, on a data channel the agent creates itself.
 */

export const ScreenMode = z.enum(["view", "control"]);
export type ScreenMode = z.infer<typeof ScreenMode>;

/** SDP is bounded: a non-trickle offer with a few host/srflx candidates is a few KB. */
export const SCREEN_SDP_MAX = 16 * 1024;

/** One WebRTC signaling message. */
export const ScreenSignal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), sdp: z.string().min(1).max(SCREEN_SDP_MAX) }),
  z.object({ kind: z.literal("answer"), sdp: z.string().min(1).max(SCREEN_SDP_MAX) }),
  z.object({
    kind: z.literal("ice"),
    candidate: z.string().max(1024),
    sdpMid: z.string().max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  }),
  /** Either end is done (the agent sends it on kill/close; a browser's close is `screen.close`). */
  z.object({ kind: z.literal("bye") }),
]);
export type ScreenSignal = z.infer<typeof ScreenSignal>;

/**
 * What the agent signs for each signal it sends (inside the sealed `screen.signal` event), so
 * the browser knows the offer (and its DTLS fingerprint) comes from the device and not from the
 * relay. `seq` increases per screen session; browsers drop anything not newer.
 */
export const ScreenSignalBody = z.object({
  v: z.literal(1),
  sid: SessionId,
  deviceId: DeviceId,
  seq: z.number().int().nonnegative(),
  t: EpochMs,
  signal: ScreenSignal,
});
export type ScreenSignalBody = z.infer<typeof ScreenSignalBody>;
export const SignedScreenSignal = signed("chalito.screen-signal.v1", ScreenSignalBody);
export type SignedScreenSignal = z.infer<typeof SignedScreenSignal>;

/** Data channel labels. The agent creates both; a channel the browser opens is closed at once. */
export const SCREEN_FRAMES_CHANNEL = "chalito-frames";
export const SCREEN_INPUT_CHANNEL = "chalito-input";

/**
 * Frames: JPEG images cut into chunks on the unordered, no-retransmit frames channel (a late
 * frame is dropped; the next one replaces it). Each chunk is a binary message:
 *   [0]     version (1)
 *   [1..4]  frame id (uint32 BE)
 *   [5..6]  chunk index (uint16 BE)
 *   [7..8]  chunk count (uint16 BE)
 *   [9..]   JPEG bytes
 * A viewer shows a frame once it has every chunk of it, and ignores frames older than the last
 * one shown.
 */
export const SCREEN_FRAME_VERSION = 1;
export const SCREEN_FRAME_HEADER = 9;
/** Under every browser's SCTP message limit (Chrome/Firefox/Safari accept ≥ 64 KiB). */
export const SCREEN_CHUNK_MAX = 60 * 1024;

/** Normalised pointer position on the shown display: 0..1 of its width and height. */
const Unit = z.number().min(0).max(1);
const Button = z.enum(["left", "right", "middle"]);

/** Text typed in one message (a paste of a sentence); longer text is several messages. */
export const SCREEN_TEXT_MAX = 200;

/**
 * Human input from the remote viewer, one JSON message per event on the input channel. Only
 * accepted in `control` mode after a `remote_control` approval; rate limited and audited as
 * counts only (never the text or keys typed).
 */
export const ScreenInput = z.discriminatedUnion("t", [
  z.object({ t: z.literal("move"), x: Unit, y: Unit }).strict(),
  z.object({ t: z.literal("button"), button: Button, down: z.boolean(), x: Unit, y: Unit }).strict(),
  z.object({ t: z.literal("click"), button: Button, double: z.boolean().default(false), x: Unit, y: Unit }).strict(),
  z
    .object({ t: z.literal("scroll"), dx: z.number().int().min(-50).max(50), dy: z.number().int().min(-50).max(50) })
    .strict(),
  /** A key or combo in the computer-control syntax ("enter", "ctrl+c"). */
  z.object({ t: z.literal("key"), keys: z.string().min(1).max(64) }).strict(),
  z.object({ t: z.literal("text"), text: z.string().min(1).max(SCREEN_TEXT_MAX) }).strict(),
]);
export type ScreenInput = z.infer<typeof ScreenInput>;

/** Largest input message the agent reads (anything bigger is dropped unparsed). */
export const SCREEN_INPUT_MAX_BYTES = 2048;

/** Where a screen session is (the `screen.state` event; plaintext metadata only). */
export const ScreenState = z.enum(["waiting_approval", "connecting", "live", "ended"]);
export type ScreenState = z.infer<typeof ScreenState>;

/** Why a screen session ended (plaintext metadata). */
export const ScreenEndReason = z.enum([
  "closed",
  "denied",
  "killed",
  "disabled",
  "indicator",
  "timeout",
  "connect_failed",
  "peer_closed",
  "client_revoked",
  "capture_failed",
  "agent_stop",
]);
export type ScreenEndReason = z.infer<typeof ScreenEndReason>;
