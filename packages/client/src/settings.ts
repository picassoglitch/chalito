import type { ChannelSetter } from "./phone.js";
import { COMPANIONS, DEFAULT_COMPANION, DEFAULT_SETTINGS, type CompanionId, type SettingsValues } from "@chalito/ui";

/**
 * Server-side settings (chalito.get_my_settings / update_my_settings / create_my_companion,
 * migration 20261004001100). Callable by the person's web session or an active client, so
 * settings work before this browser is paired. Shapes follow the notifier exactly.
 */
export interface ServerSettings {
  locale: "es" | "en";
  tz: string | null;
  call_briefing: { enabled: boolean } | null;
  quiet_hours: null | { off: true } | { start: string; end: string };
  privacy_mode: "private" | "cloud_assist";
  render_quality: SettingsValues["renderQuality"];
  whatsapp_opt_in: boolean;
  calls_enabled: boolean;
  sms_enabled: boolean | null;
  prefs: Record<string, unknown>;
  phone_pending_e164: string | null;
  phone_e164: string | null;
  phone_verified_at: string | null;
  charges_notice_ack_at: string | null;
}

type Result = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
/** The supabase-js slice used here (schema `chalito`). */
export interface SettingsDb {
  rpc(fn: string, args?: Record<string, unknown>): Result;
  from(table: string): {
    select(cols?: string): { eq(c: string, v: unknown): Result & { maybeSingle(): Result } };
    update(patch: Record<string, unknown>): { eq(c: string, v: unknown): Result };
  };
}

export type SettingsErrorCode =
  | "rejected"
  | "companion_exists"
  | "phone_not_verified"
  | "charges_notice_required"
  | "country_not_supported"
  | "failed";

export class SettingsError extends Error {
  override name = "SettingsError";
  constructor(
    readonly code: SettingsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const must = async <T>(r: Result): Promise<T> => {
  const { data, error } = await r;
  if (error) {
    // 23514: a CHECK (e.g. opt-ins without a verified phone + charges ack); 22023: refused key/shape.
    const code =
      error.code === "23505"
        ? "companion_exists"
        : error.code === "23514" || error.code === "22023"
          ? "rejected"
          : "failed";
    throw new SettingsError(code, error.message);
  }
  return data as T;
};

interface Companion {
  companion_id: string;
  name: string;
  is_renamed: boolean;
  avatar: string | null;
}
interface ConnectionRow {
  provider: string;
  device_id: string;
  doc: { mode: SettingsValues["connections"][number]["mode"]; connected: boolean };
}

/** Server rows → the shared SettingsValues the UI edits. */
export const fromServer = (
  s: ServerSettings,
  extra: { companion: Companion | null; connections: ConnectionRow[]; tier: string | null },
): SettingsValues => {
  const q = s.quiet_hours;
  return {
    phone: { e164: s.phone_e164 ?? s.phone_pending_e164, verified: !!s.phone_verified_at },
    chargesAck: !!s.charges_notice_ack_at,
    whatsapp: s.whatsapp_opt_in,
    calls: s.calls_enabled,
    callBriefing: s.call_briefing?.enabled === true,
    quietHours:
      q === null
        ? { ...DEFAULT_SETTINGS.quietHours, mode: "default" }
        : "off" in q
          ? { ...DEFAULT_SETTINGS.quietHours, mode: "off" }
          : { mode: "custom", start: q.start, end: q.end },
    avatar: (COMPANIONS as readonly string[]).includes(extra.companion?.avatar ?? "")
      ? (extra.companion!.avatar as CompanionId)
      : DEFAULT_COMPANION,
    companionName: {
      name: extra.companion?.is_renamed ? extra.companion.name : "",
      isRenamed: !!extra.companion?.is_renamed,
    },
    privacyMode: s.privacy_mode === "private",
    connections: extra.connections.map((c) => ({
      provider: c.provider,
      deviceId: c.device_id,
      mode: c.doc.mode,
      connected: c.doc.connected,
    })),
    planCredits: { tier: extra.tier, trialEndsAt: null },
    renderQuality: s.render_quality,
  };
};

/** One UI change → the update_my_settings patch, or null for settings that live elsewhere. */
export const toServerPatch = <K extends keyof SettingsValues>(
  k: K,
  v: SettingsValues[K],
): Record<string, unknown> | null => {
  switch (k) {
    case "whatsapp":
      return { whatsapp_opt_in: v };
    case "calls":
      return { calls_enabled: v };
    case "callBriefing":
      return { call_briefing: { enabled: v } };
    case "chargesAck":
      return { charges_notice_ack_at: v };
    case "privacyMode":
      return { privacy_mode: v ? "private" : "cloud_assist" };
    case "renderQuality":
      return { render_quality: v };
    case "quietHours": {
      const q = v as SettingsValues["quietHours"];
      return {
        quiet_hours: q.mode === "default" ? null : q.mode === "off" ? { off: true } : { start: q.start, end: q.end },
      };
    }
    default:
      // phone: only phone_pending_e164, set when a code is requested (the server verifies);
      // avatar/companionName: the companions row; connections/planCredits: read-only here.
      return null;
  }
};

export class SettingsStore {
  constructor(
    private readonly db: SettingsDb,
    private readonly owner: string,
    /** Paid channels go through the api (/v1/phone/channels): the RPC refuses turning them on. */
    private readonly channels: ChannelSetter,
  ) {}

  async load(): Promise<{ values: SettingsValues; onboarded: boolean }> {
    const [s, companion, connections, user] = await Promise.all([
      must<ServerSettings>(this.db.rpc("get_my_settings")),
      must<Companion | null>(
        this.db.from("companions").select("companion_id,name,is_renamed,avatar").eq("owner", this.owner).maybeSingle(),
      ),
      must<ConnectionRow[]>(this.db.from("connections").select("provider,device_id,doc").eq("owner", this.owner)),
      must<{ tier: string | null } | null>(this.db.from("users").select("tier").eq("id", this.owner).maybeSingle()),
    ]);
    return {
      values: fromServer(s, { companion, connections: connections ?? [], tier: user?.tier ?? null }),
      onboarded: typeof s.prefs?.onboarded_at === "string",
    };
  }

  /** Saves one setting; returns the server's view afterwards (e.g. a refused opt-in stays off). */
  async save<K extends keyof SettingsValues>(k: K, v: SettingsValues[K]): Promise<void> {
    if (k === "avatar" || k === "companionName") return; // saved together by saveCompanion
    if (k === "whatsapp" || k === "calls") {
      const r = await this.channels(k === "whatsapp" ? { whatsapp: v as boolean } : { calls: v as boolean });
      if (!r.ok) throw new SettingsError(r.reason === "error" ? "failed" : r.reason, r.reason);
      return;
    }
    const patch = toServerPatch(k, v);
    if (patch) await must(this.db.rpc("update_my_settings", { p: patch }));
  }

  /** The browser proposes a number; the api sends the code and the server stores it verified. */
  async proposePhone(e164: string): Promise<void> {
    await must(this.db.rpc("update_my_settings", { p: { phone_pending_e164: e164 } }));
  }

  /** Creates the companion once (create_my_companion), then renames it through the column grant. */
  async saveCompanion(v: Pick<SettingsValues, "avatar" | "companionName">): Promise<void> {
    const name =
      v.companionName.isRenamed && v.companionName.name.trim() ? v.companionName.name.trim().slice(0, 40) : "Chalito";
    try {
      await must(
        this.db.rpc("create_my_companion", {
          p_name: name,
          p_avatar: v.avatar,
          p_is_renamed: v.companionName.isRenamed,
        }),
      );
    } catch (err) {
      if (!(err instanceof SettingsError && err.code === "companion_exists")) throw err;
      await must(
        this.db
          .from("companions")
          .update({ name, is_renamed: v.companionName.isRenamed, avatar: v.avatar })
          .eq("owner", this.owner),
      );
    }
  }

  async markOnboarded(): Promise<void> {
    await must(this.db.rpc("update_my_settings", { p: { prefs: { onboarded_at: new Date().toISOString() } } }));
  }
}
