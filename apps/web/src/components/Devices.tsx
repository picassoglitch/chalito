"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { DeviceView } from "@chalito/client";
import { Link } from "@/i18n/navigation";
import { useChalito, useLive } from "./ChalitoProvider";
import { PasskeyEnroll } from "./PasskeyEnroll";
import { SharingToggle } from "./SharingToggle";

/**
 * Devices: online/offline, Developer mode, revoke. Developer mode can only be turned OFF here
 * (the whole toggle or one toggle); there is no control, route or action that turns it on.
 */
export const Devices = () => {
  const t = useTranslations("live.devices");
  const { devices } = useLive();
  const { client, deviceId: me } = useChalito();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const agents = devices.filter((d) => d.role === "agent" && !d.revoked);

  const send = async (f: () => Promise<unknown>, ok: string) => {
    setNote(null);
    try {
      await f();
      setNote(t(ok));
    } catch {
      setNote(t("failed"));
    }
  };

  /** A client is revoked on every agent that trusts this device (each removes it from its local list). */
  const revoke = async (d: DeviceView) => {
    if (!client) return;
    const results = await Promise.allSettled(agents.map((a) => client.actions.revokeClient(a.deviceId, d.deviceId)));
    setConfirming(null);
    setNote(results.some((r) => r.status === "fulfilled") ? t("revokeSent") : t("failed"));
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <Link
          href="/dispositivos/nuevo"
          data-testid="add-device-link"
          className="ml-auto rounded-lg bg-emerald-700 px-3 py-1.5 text-sm text-white"
        >
          {t("add")}
        </Link>
      </div>
      <PasskeyEnroll />
      <ul className="grid gap-3">
        {devices.map((d) => (
          <li
            key={d.deviceId}
            data-testid="device"
            data-device={d.deviceId}
            className="grid gap-2 rounded-xl border bg-white p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{d.name}</span>
              <span className="text-sm text-neutral-600">{t(`role.${d.role}`)}</span>
              <span
                data-testid="presence"
                className={`ml-auto rounded-full px-2 py-0.5 text-xs ${d.revoked ? "bg-neutral-200" : d.online ? "bg-emerald-100 text-emerald-900" : "bg-neutral-100"}`}
              >
                {d.revoked ? t("revoked") : d.online ? t("online") : t("offline")}
              </span>
            </div>
            {d.role === "agent" && !d.revoked ? <SharingToggle scope="device" target={d.deviceId} /> : null}
            {d.devMode.on ? (
              <div data-testid="devmode-controls" className="grid gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-900">
                <p className="font-semibold">{t("devModeOn", { toggles: d.devMode.toggles.join(", ") })}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    data-testid="devmode-off"
                    className="rounded border border-red-700 px-2 py-1"
                    onClick={() => client && void send(() => client.actions.devmodeOff(d.deviceId), "devModeOffSent")}
                  >
                    {t("devModeOff")}
                  </button>
                  {d.devMode.toggles.map((tg) => (
                    <button
                      key={tg}
                      data-testid="devmode-toggle-off"
                      className="rounded border px-2 py-1"
                      onClick={() =>
                        client &&
                        void send(() => client.actions.devmodeToggleOff(d.deviceId, tg as never), "devModeOffSent")
                      }
                    >
                      {t("toggleOff", { toggle: tg })}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {d.role === "client" && !d.revoked && d.deviceId !== me ? (
              confirming === d.deviceId ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{t("revokeConfirm", { name: d.name })}</span>
                  <button className="rounded bg-red-700 px-2 py-1 text-white" onClick={() => void revoke(d)}>
                    {t("revokeYes")}
                  </button>
                  <button className="rounded border px-2 py-1" onClick={() => setConfirming(null)}>
                    {t("cancel")}
                  </button>
                </div>
              ) : (
                <button className="w-fit rounded border px-2 py-1 text-sm" onClick={() => setConfirming(d.deviceId)}>
                  {t("revoke")}
                </button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      {note ? <p role="status">{note}</p> : null}
    </div>
  );
};
