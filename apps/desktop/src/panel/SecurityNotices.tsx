import { useSyncExternalStore } from "react";
import type { ChalitoClient, DeviceView } from "@chalito/client";
import { DeviceEvent } from "@chalito/protocol";
import { useT } from "../lib/i18n.js";

type Refusal = Extract<DeviceEvent, { type: "trust.endorsement_refused" }>;

/** Agents whose latest event is a refused endorsement (R-L13: never silent). */
export const endorsementRefusals = (devices: readonly DeviceView[]): { agent: DeviceView; event: Refusal }[] =>
  devices.flatMap((d) => {
    if (d.role !== "agent" || d.revoked) return [];
    const e = DeviceEvent.safeParse(d.lastEvent);
    return e.success && e.data.type === "trust.endorsement_refused" ? [{ agent: d, event: e.data }] : [];
  });

export const SecurityNotices = ({ client }: { client: Pick<ChalitoClient, "live"> }) => {
  const t = useT();
  const snap = useSyncExternalStore(client.live.subscribe, client.live.getSnapshot);
  const refusals = endorsementRefusals(snap.devices);
  if (!refusals.length) return null;
  return (
    <section aria-labelledby="sec-notices" data-section="notices" className="card">
      <h2 id="sec-notices">{t("security.notices.title")}</h2>
      <ul className="list">
        {refusals.map(({ agent, event }) => (
          <li key={`${agent.deviceId}:${event.clientDeviceId}`} role="alert">
            {t(`security.notices.${event.reason === "missing_step_up" ? "missingStepUp" : "refused"}`, {
              computer: agent.name,
            })}
          </li>
        ))}
      </ul>
    </section>
  );
};
