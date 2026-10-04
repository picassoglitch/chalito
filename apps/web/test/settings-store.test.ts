import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@chalito/ui";
import { vi } from "vitest";
import {
  SettingsError,
  SettingsStore,
  fromServer,
  toServerPatch,
  type ServerSettings,
  type SettingsDb,
} from "@/lib/settings-store";
import { assertNoDevBackendOnVercel } from "../next.config";

const SERVER: ServerSettings = {
  locale: "es",
  tz: "America/Mexico_City",
  call_briefing: { enabled: true },
  quiet_hours: null,
  privacy_mode: "private",
  render_quality: "medio",
  whatsapp_opt_in: true,
  calls_enabled: false,
  sms_enabled: null,
  prefs: {},
  phone_pending_e164: null,
  phone_e164: "+525512345678",
  phone_verified_at: "2026-10-04T00:00:00Z",
  charges_notice_ack_at: "2026-10-04T00:00:00Z",
};

describe("settings ↔ update_my_settings shapes (the notifier's, exactly)", () => {
  it("quiet hours are tri-state: null = default, {off: true} = none, {start, end} = custom", () => {
    const q = (mode: "default" | "off" | "custom") =>
      toServerPatch("quietHours", { mode, start: "23:00", end: "07:30" });
    expect(q("default")).toEqual({ quiet_hours: null });
    expect(q("off")).toEqual({ quiet_hours: { off: true } });
    expect(q("custom")).toEqual({ quiet_hours: { start: "23:00", end: "07:30" } });
    const extra = { companion: null, connections: [], tier: null };
    expect(fromServer({ ...SERVER, quiet_hours: { off: true } }, extra).quietHours.mode).toBe("off");
    expect(fromServer({ ...SERVER, quiet_hours: { start: "21:00", end: "06:00" } }, extra).quietHours).toEqual({
      mode: "custom",
      start: "21:00",
      end: "06:00",
    });
  });

  it("uses the server's column names and never sends the phone itself", () => {
    expect(toServerPatch("calls", true)).toEqual({ calls_enabled: true });
    expect(toServerPatch("whatsapp", true)).toEqual({ whatsapp_opt_in: true });
    expect(toServerPatch("chargesAck", true)).toEqual({ charges_notice_ack_at: true });
    expect(toServerPatch("callBriefing", false)).toEqual({ call_briefing: { enabled: false } });
    expect(toServerPatch("privacyMode", false)).toEqual({ privacy_mode: "cloud_assist" });
    expect(toServerPatch("phone", { e164: "+525512345678", verified: true })).toBeNull();
    expect(toServerPatch("connections", [])).toBeNull();
  });

  it("reads verified phone, ack, connections, companion and tier", () => {
    const v = fromServer(SERVER, {
      companion: { companion_id: "chl_x", name: "Pepe", is_renamed: true, avatar: "luna" },
      connections: [{ provider: "anthropic", device_id: "dev_a", doc: { mode: "byo_api_key", connected: true } }],
      tier: "pro",
    });
    expect(v).toMatchObject({
      phone: { e164: "+525512345678", verified: true },
      chargesAck: true,
      whatsapp: true,
      callBriefing: true,
      privacyMode: true,
      avatar: "luna",
      companionName: { name: "Pepe", isRenamed: true },
      connections: [{ provider: "anthropic", deviceId: "dev_a", mode: "byo_api_key", connected: true }],
      planCredits: { tier: "pro" },
      renderQuality: "medio",
    });
    const pending = fromServer(
      { ...SERVER, phone_e164: null, phone_verified_at: null, phone_pending_e164: "+525599999999" },
      {
        companion: null,
        connections: [],
        tier: null,
      },
    );
    expect(pending.phone).toEqual({ e164: "+525599999999", verified: false });
    expect(pending.avatar).toBe(DEFAULT_SETTINGS.avatar);
  });
});

describe("dev backend guard", () => {
  it("refuses to build the mock backend anywhere on Vercel", () => {
    expect(() => assertNoDevBackendOnVercel({ NEXT_PUBLIC_CHALITO_DEV_BACKEND: "1", VERCEL: "1" })).toThrow();
    expect(() => assertNoDevBackendOnVercel({ NEXT_PUBLIC_CHALITO_DEV_BACKEND: "1", VERCEL_ENV: "preview" })).toThrow();
    expect(() => assertNoDevBackendOnVercel({ NEXT_PUBLIC_CHALITO_DEV_BACKEND: "1" })).not.toThrow();
    expect(() => assertNoDevBackendOnVercel({ VERCEL: "1" })).not.toThrow();
  });
});

describe("SettingsStore writes", () => {
  const fakeDb = () => {
    const calls: [string, unknown][] = [];
    const db = {
      rpc: (fn: string, args?: unknown) => (
        calls.push([`rpc:${fn}`, args]),
        Promise.resolve({ data: {}, error: null })
      ),
      from: (t: string) => ({
        select: () => ({
          eq: () =>
            Object.assign(Promise.resolve({ data: null, error: null }), {
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
        }),
        update: (patch: unknown) => ({
          eq: () => (calls.push([`update:${t}`, patch]), Promise.resolve({ data: null, error: null })),
        }),
      }),
    };
    return { db: db as unknown as SettingsDb, calls };
  };

  it("paid channels go through the api; everything else through update_my_settings", async () => {
    const { db, calls } = fakeDb();
    const channels = vi.fn(async () => ({ ok: true as const }));
    const store = new SettingsStore(db, "u1", channels);
    await store.save("calls", true);
    await store.save("whatsapp", false);
    await store.save("privacyMode", false);
    expect(channels.mock.calls).toEqual([[{ calls: true }], [{ whatsapp: false }]]);
    expect(calls).toEqual([["rpc:update_my_settings", { p: { privacy_mode: "cloud_assist" } }]]);
  });

  it("the api's refusals come back as typed errors", async () => {
    const { db } = fakeDb();
    const store = new SettingsStore(db, "u1", async () => ({ ok: false, reason: "country_not_supported" }));
    await expect(store.save("calls", true)).rejects.toMatchObject({ code: "country_not_supported" });
    await expect(store.save("calls", true)).rejects.toBeInstanceOf(SettingsError);
  });

  it("an existing companion is updated in place, avatar included", async () => {
    const { db, calls } = fakeDb();
    db.rpc = () => Promise.resolve({ data: null, error: { message: "companion_exists", code: "23505" } });
    await new SettingsStore(db, "u1", async () => ({ ok: true })).saveCompanion({
      avatar: "luna",
      companionName: { name: "Pepe", isRenamed: true },
    });
    expect(calls).toEqual([["update:companions", { name: "Pepe", is_renamed: true, avatar: "luna" }]]);
  });
});
