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
  /** E.164, or null when not set. */
  phone: string | null;
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
  phone: null,
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
export const chargesApply = (v: Pick<SettingsValues, "whatsapp" | "calls">): boolean => v.whatsapp || v.calls;
