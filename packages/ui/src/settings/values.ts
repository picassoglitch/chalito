import type { CompanionId } from "../companions.js";
import { DEFAULT_COMPANION } from "../companions.js";

/** Render quality levels (packages/config/render.yaml: `auto` plus its `levels`). */
export const RENDER_QUALITIES = ["auto", "bajo", "medio", "alto"] as const;
export type RenderQuality = (typeof RENDER_QUALITIES)[number];

/** chalito.connections doc.mode (valid_connection_doc in the settings migration). */
export type ConnectionMode = "byo_api_key" | "byo_subscription_local" | "byo_mcp_connector" | "managed";

export interface ConnectionStatus {
  /** Provider id from providers.yaml (anthropic, openai, xai, google). */
  provider: string;
  /** The device that reported it (connections are per device + provider). */
  deviceId?: string;
  mode: ConnectionMode;
  connected: boolean;
}

/**
 * The notifier's tri-state (users.quiet_hours): `default` = the default window (null),
 * `off` = no quiet hours ({"off": true}), `custom` = {start, end}.
 */
export interface QuietHours {
  mode: "default" | "off" | "custom";
  start: string;
  end: string;
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
  quietHours: QuietHours;
  avatar: CompanionId;
  companionName: { name: string; isRenamed: boolean };
  /** users.privacy_mode: true = "private" (the default), false = "cloud_assist". */
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
  quietHours: { mode: "default", start: "22:00", end: "08:00" },
  avatar: DEFAULT_COMPANION,
  companionName: { name: "", isRenamed: false },
  privacyMode: true,
  connections: [],
  planCredits: { tier: null, trialEndsAt: null },
  renderQuality: "auto",
};

/** Channels that can cost the user money (carrier/WhatsApp charges): show the charges notice. */
/** Calls/SMS/WhatsApp need a verified phone and the charges acknowledgement. */
export const canOptIn = (v: Pick<SettingsValues, "phone" | "chargesAck">): boolean => v.phone.verified && v.chargesAck;

export const chargesApply = (v: Pick<SettingsValues, "whatsapp" | "calls">): boolean => v.whatsapp || v.calls;

/**
 * Phone verification through the api (apps/api phone routes, Twilio Verify behind them). The
 * charges acknowledgement comes first: `start` requires it. Injected so shells and tests can mock it.
 */
export interface PhoneVerifier {
  /** Sends a code by SMS or a voice call. Only callable after "Entiendo que pueden aplicar cargos". */
  start(
    e164: string,
    opts: { channel: "sms" | "call"; locale: "es" | "en" },
  ): Promise<{ ok: true } | { ok: false; reason: "invalid" | "charges_notice_required" | "rate_limited" | "error" }>;
  /** Checks the code; on success the server stores the number as verified (and records the acknowledgement). */
  check(e164: string, code: string): Promise<{ ok: true } | { ok: false; reason: "wrong_code" | "in_use" | "error" }>;
}
