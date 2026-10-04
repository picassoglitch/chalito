"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { DeviceView } from "@chalito/client";
import { DeviceEvent } from "@chalito/protocol";
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
  const { client, deviceId: me, revokeDevice } = useChalito();
  /** Per-computer outcome of the last revoke: delivered now, or offline (its access is already cut). */
  const [revoked, setRevoked] = useState<{
    name: string;
    agents: { name: string; online: boolean; sent: boolean }[];
  } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const agents = devices.filter((d) => d.role === "agent" && !d.revoked);
  // R-L13 / ADR 0018: a computer that refused an endorsement says so (never silent).
  const refusals = agents.flatMap((d) => {
    const e = DeviceEvent.safeParse(d.lastEvent);
    return e.success && e.data.type === "trust.endorsement_refused" ? [{ agent: d, event: e.data }] : [];
  });

  const send = async (f: () => Promise<unknown>, ok: string) => {
    setNote(null);
    try {
      await f();
      setNote(t(ok));
    } catch {
      setNote(t("failed"));
    }
  };

  /**
   * Review R-H5: first the SERVER (the device's account is disabled and its sessions end, so it
   * can't reach any computer through Chalito again), then a signed revokeClient to every computer
   * so each drops the key from its local trust list.
   */
  const revoke = async (d: DeviceView) => {
    if (!client || !revokeDevice) return;
    setNote(null);
    setRevoked(null);
    const server = await revokeDevice(d.deviceId);
    setConfirming(null);
    if (server !== "ok") return setNote(t("revokeFailed"));
    const results = await Promise.allSettled(agents.map((a) => client.actions.revokeClient(a.deviceId, d.deviceId)));
    setRevoked({
      name: d.name,
      agents: agents.map((a, i) => ({ name: a.name, online: a.online, sent: results[i]!.status === "fulfilled" })),
    });
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
      {refusals.length ? (
        <section
          aria-labelledby="sec-notices"
          className="grid gap-1 rounded-xl border border-amber-300 bg-amber-50 p-4"
        >
          <h2 id="sec-notices" className="font-semibold">
            {t("notices.title")}
          </h2>
          <ul className="grid gap-1 text-sm">
            {refusals.map(({ agent, event }) => (
              <li
                key={`${agent.deviceId}:${event.clientDeviceId}`}
                role="alert"
                data-testid="endorse-refused"
                data-reason={event.reason}
              >
                {t(event.reason === "missing_step_up" ? "notices.missingStepUp" : "notices.refused", {
                  computer: agent.name,
                })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
      {revoked ? (
        <div role="status" data-testid="revoke-result" className="grid gap-1 rounded-lg bg-neutral-100 p-3 text-sm">
          <p className="font-medium">{t("revokedServer", { name: revoked.name })}</p>
          <ul className="grid gap-0.5">
            {revoked.agents.map((a) => (
              <li key={a.name} data-testid="revoke-agent" data-online={a.online}>
                {a.online && a.sent
                  ? t("revokeAgentOnline", { agent: a.name })
                  : t("revokeAgentOffline", { agent: a.name })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {note ? <p role="status">{note}</p> : null}
    </div>
  );
};
