import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChalitoClient } from "@chalito/client";
import { useT } from "../lib/i18n.js";
import { ApprovalRow } from "./Inbox.js";

// ADR 0032 — a waiting approval shows over any tab and `onNew` brings the panel forward for each
// new one. "Later" only hides it here; it stays in the inbox.
export const ApprovalPopup = ({
  client,
  canStepUp,
  hidden,
  onNew,
  onOpenInbox,
}: {
  client: Pick<ChalitoClient, "live" | "actions">;
  canStepUp: boolean;
  /** The inbox is open: it already lists them. */
  hidden: boolean;
  onNew?: () => void;
  onOpenInbox: () => void;
}) => {
  const t = useT();
  const snap = useSyncExternalStore(client.live.subscribe, client.live.getSnapshot);
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  // Re-render every second so an approval that expires while shown leaves.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const waiting = snap.approvals.filter((a) => a.status === "pending" && a.expiresAt > now && !later.has(a.aid));

  useEffect(() => {
    const fresh = waiting.filter((a) => !seen.current.has(a.aid));
    for (const a of fresh) seen.current.add(a.aid);
    if (fresh.length) onNew?.();
  }, [waiting, onNew]);

  const a = waiting[0];
  const shown = a?.aid;
  useEffect(() => setError(null), [shown]);
  if (hidden || !a) return null;
  const run = (p: Promise<void>) =>
    void p.then(
      () => setError(null),
      (e: unknown) => setError(t("inbox.error", { reason: e instanceof Error ? e.message : String(e) })),
    );
  return (
    <section role="region" aria-labelledby="approval-popup-title" data-section="approval-popup" className="card popup">
      <h2 id="approval-popup-title">{t("popup.title")}</h2>
      {error && <p role="alert">{error}</p>}
      <ul className="list">
        {/* Keyed: one approval's expanded input must never carry over to the next. */}
        <ApprovalRow
          key={a.aid}
          a={a}
          canStepUp={canStepUp}
          run={run}
          decide={(aid, allow) => client.actions.decide(aid, allow)}
        />
      </ul>
      <div className="row">
        {waiting.length > 1 && <button onClick={onOpenInbox}>{t("popup.all", { count: waiting.length })}</button>}
        <button data-popup-later onClick={() => (setError(null), setLater((s) => new Set(s).add(a.aid)))}>
          {t("popup.later")}
        </button>
      </div>
    </section>
  );
};
