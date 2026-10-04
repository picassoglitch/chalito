import { useState, useSyncExternalStore } from "react";
import type { ChalitoClient } from "@chalito/client";
import { useT } from "../lib/i18n.js";

const summary = (d: Record<string, unknown> | null, fallback: string): string =>
  typeof d?.summary === "string" ? d.summary : typeof d?.tool === "string" ? d.tool : fallback;

/** Pending approvals and notices from the live store, the same rows the PWA shows. */
export const Inbox = ({ client }: { client: Pick<ChalitoClient, "live" | "actions"> }) => {
  const t = useT();
  const snap = useSyncExternalStore(client.live.subscribe, client.live.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const pending = snap.approvals.filter((a) => a.status === "pending");
  const notices = snap.notifications.filter((n) => n.state === "pending");
  const run = (p: Promise<void>) =>
    p.then(
      () => setError(null),
      (e: unknown) => setError(t("inbox.error", { reason: e instanceof Error ? e.message : String(e) })),
    );

  if (!pending.length && !notices.length) return <p className="muted">{t("inbox.empty")}</p>;
  return (
    <div className="stack">
      {error && <p role="alert">{error}</p>}
      {pending.length > 0 && (
        <section aria-labelledby="inbox-approvals">
          <h2 id="inbox-approvals">{t("inbox.approvals")}</h2>
          <ul className="list">
            {pending.map((a) => (
              <li key={a.aid} data-aid={a.aid} className={`card risk-${a.risk.toLowerCase()}`}>
                <strong>{summary(a.details, a.origin)}</strong>
                <span className="muted">{t("inbox.risk", { risk: a.risk })}</span>
                <div className="row">
                  <button onClick={() => void run(client.actions.decide(a.aid, true))}>{t("inbox.approve")}</button>
                  <button onClick={() => void run(client.actions.decide(a.aid, false))}>{t("inbox.deny")}</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {notices.length > 0 && (
        <section aria-labelledby="inbox-notices">
          <h2 id="inbox-notices">{t("inbox.notifications")}</h2>
          <ul className="list">
            {notices.map((n) => (
              <li key={n.nid} data-nid={n.nid} className="card">
                <span>
                  {n.level} · {n.source}
                </span>
                <button onClick={() => void run(client.actions.ackNotification(n.nid))}>{t("inbox.ack")}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};
