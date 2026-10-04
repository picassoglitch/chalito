import type { CompanionId } from "../companions.js";
import { DEFAULT_COMPANION } from "../companions.js";

/** Render quality levels (packages/config/render.yaml: `auto` plus its `levels`). */
export const RENDER_QUALITIES = ["auto", "bajo", "medio", "alto"] as const;
export type RenderQuality = (typeof RENDER_QUALITIES)[number];

export type ConnectionMode = "api_key" | "subscription" | "managed" | "none";

export interface ConnectionStatus {
  /** Provider id from providers.yaml (anthropic, openai, xai, google). */
  provider: string;
  mode: ConnectionMode;
  connected: boolean;
}

/** Every user setting, as the settings screens edit it. Secrets are never part of it. */
export interface SettingsValues {
  /**
   * The browser only ever proposes a number (`phone_pending_e164`); the server writes the
   * verified one after the code check (Twilio Verify). `verified` reflects that.
   */
  phone: { e164: string | null; verified: boolean };
  /** "Entiendo que pueden aplicar cargos": required before calls/SMS/WhatsApp can be turned on. */
  chargesAck: boolean;
  whatsapp: boolean;
  calls: boolean;
  callBriefing: boolean;
  quietHours: { enabled: boolean; from: string; to: string };
  avatar: CompanionId;
  companionName: { name: string; isRenamed: boolean };
  privacyMode: boolean;
  connections: ConnectionStatus[];
  /** From the hub (read-only here): the tier label key and whether a trial is running. */
  planCredits: { tier: string | null; trialEndsAt: string | null };
  renderQuality: RenderQuality;
}

export const DEFAULT_SETTINGS: SettingsValues = {
  phone: { e164: null, verified: false },
  chargesAck: false,
  whatsapp: false,
  calls: false,
  callBriefing: false,
  quietHours: { enabled: false, from: "22:00", to: "08:00" },
  avatar: DEFAULT_COMPANION,
  companionName: { name: "", isRenamed: false },
  privacyMode: false,
  connections: [],
  planCredits: { tier: null, trialEndsAt: null },
  renderQuality: "auto",
};

/** Channels that can cost the user money (carrier/WhatsApp charges): show the charges notice. */
/** Calls/SMS/WhatsApp need a verified phone and the charges acknowledgement. */
export const canOptIn = (v: Pick<SettingsValues, "phone" | "chargesAck">): boolean => v.phone.verified && v.chargesAck;

export const chargesApply = (v: Pick<SettingsValues, "whatsapp" | "calls">): boolean => v.whatsapp || v.calls;

/** Phone verification (api route, Twilio Verify behind it). Injected so the shells and tests can mock it. */
export interface PhoneVerifier {
  /** Sends a code to `e164`. */
  start(e164: string): Promise<{ ok: true } | { ok: false; reason: "invalid" | "rate_limited" | "error" }>;
  /** Checks the code; on success the server stores the number as verified. */
  check(e164: string, code: string): Promise<{ ok: true } | { ok: false; reason: "wrong_code" | "expired" | "error" }>;
}
