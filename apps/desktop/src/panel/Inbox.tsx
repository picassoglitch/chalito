import { useState, useSyncExternalStore } from "react";
import { AlertActionsUnavailable, type ApprovalView, type ChalitoClient } from "@chalito/client";
import { useT } from "../lib/i18n.js";
import { approvalSummary, approveBlock } from "../lib/approval-rules.js";
import type { WaitingOn } from "../lib/alert-notice.js";
import { AlertReasonLine, NoticeCalmButtons, WaitingList, type Alerts } from "./AlertControls.js";

const noSubscribe = () => () => undefined;

/** One pending approval (ADR 0019). Unverified here: deny only. A truncated summary (R-M10) must be opened in full
 * before approving, so the person has seen everything they sign. */
export const ApprovalRow = ({
  a,
  canStepUp,
  run,
  decide,
}: {
  a: ApprovalView;
  canStepUp: boolean;
  run: (p: Promise<void>) => void;
  decide: (aid: string, allow: boolean) => Promise<void>;
}) => {
  const t = useT();
  const truncated = a.details?.summaryTruncated === true;
  const block = approveBlock(a, canStepUp);
  const [expanded, setExpanded] = useState(false);
  return (
    <li data-aid={a.aid} data-verified={a.verified} className={`card risk-${a.risk.toLowerCase()}`}>
      <strong>{approvalSummary(a)}</strong>
      {!a.verified && (
        <span className="warn" data-unverified>
          {t("inbox.unverified")}
        </span>
      )}
      <span className="muted">{t("inbox.risk", { risk: a.risk })}</span>
      {truncated && (
        <details onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}>
          <summary>{t("inbox.showFull")}</summary>
          <pre className="full-input">{JSON.stringify(a.details?.input ?? null, null, 2)}</pre>
        </details>
      )}
      <div className="row">
        {block === "unverified" ? null : block === "phoneOnly" ? (
          <span className="muted" data-phone-only>
            {t("inbox.approveOnPhone")}
          </span>
        ) : (
          <button
            disabled={truncated && !expanded}
            title={truncated && !expanded ? t("inbox.openFullFirst") : undefined}
            onClick={() => void run(decide(a.aid, true))}
          >
            {t("inbox.approve")}
          </button>
        )}
        <button onClick={() => void run(decide(a.aid, false))}>{t("inbox.deny")}</button>
      </div>
    </li>
  );
};

/** A room event's deep link (/r/<roomId>, as the notifier writes it): the room to open. */
export const roomOf = (n: { source: string; deepLink: string }): string | null =>
  n.source === "room_event" ? (/^\/(?:en\/)?r\/([A-Za-z0-9_-]{1,128})$/.exec(n.deepLink)?.[1] ?? null) : null;

/** Pending approvals and notices, as the PWA shows them. Without a passkey here (e.g. WebKitGTK) a HIGH/CRITICAL
 * approve can't carry its step-up: the row says to approve from the phone; deny always works. */
export const Inbox = ({
  client,
  canStepUp,
  onOpenRoom,
  alerts,
  waiting,
  onOpenSession,
}: {
  client: Pick<ChalitoClient, "live" | "actions">;
  canStepUp: boolean;
  /** Room event notifications deep-link into the room window. */
  onOpenRoom?: (roomId: string) => void;
  /** Postpone and "Esperando a alguien" (from Alux, by Omar); without them the rows show only "Visto". */
  alerts?: Alerts;
  waiting?: WaitingOn;
  onOpenSession?: (sid: string) => void;
}) => {
  const t = useT();
  const snap = useSyncExternalStore(client.live.subscribe, client.live.getSnapshot);
  // Redraw when the alert actions go missing or come back (a retry after a missing function).
  const available = useSyncExternalStore(alerts?.subscribe ?? noSubscribe, () => alerts?.available ?? true);
  const [error, setError] = useState<string | null>(null);
  const [, bump] = useState(0);
  const calm =
    alerts && waiting
      ? {
          alerts,
          waiting,
          available,
          onChange: () => bump((n) => n + 1),
          ...(onOpenSession ? { onOpen: onOpenSession } : {}),
        }
      : null;
  const pending = snap.approvals.filter((a) => a.status === "pending");
  const notices = snap.notifications.filter((n) => n.state === "pending");
  const run = (p: Promise<void>) =>
    p.then(
      () => setError(null),
      (e: unknown) =>
        setError(
          e instanceof AlertActionsUnavailable
            ? t("alerts.unavailable")
            : t("inbox.error", { reason: e instanceof Error ? e.message : String(e) }),
        ),
    );

  const waitingList = calm && <WaitingList {...calm} sessions={snap.sessions} run={(p) => void run(p)} />;
  if (!pending.length && !notices.length)
    return (
      <>
        <p className="muted">{t("inbox.empty")}</p>
        {waitingList}
      </>
    );
  return (
    <div className="stack">
      {error && <p role="alert">{error}</p>}
      {pending.length > 0 && (
        <section aria-labelledby="inbox-approvals">
          <h2 id="inbox-approvals">{t("inbox.approvals")}</h2>
          <ul className="list">
            {pending.map((a) => (
              <ApprovalRow
                key={a.aid}
                a={a}
                canStepUp={canStepUp}
                run={run}
                decide={(aid, allow) => client.actions.decide(aid, allow)}
              />
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
                <AlertReasonLine n={n} events={snap.events} />
                {onOpenRoom && roomOf(n) && (
                  <button
                    onClick={() => {
                      onOpenRoom(roomOf(n)!);
                      void run(client.actions.ackNotification(n.nid));
                    }}
                  >
                    {t("inbox.openRoom")}
                  </button>
                )}
                <button onClick={() => void run(client.actions.ackNotification(n.nid))}>{t("inbox.ack")}</button>
                {calm && <NoticeCalmButtons {...calm} n={n} sessions={snap.sessions} run={(p) => void run(p)} />}
              </li>
            ))}
          </ul>
        </section>
      )}
      {waitingList}
    </div>
  );
};
