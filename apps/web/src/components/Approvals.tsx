"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ActionError, type ApprovalView } from "@chalito/client";
import { Link } from "@/i18n/navigation";
import { useChalito, useLive, useNow } from "./ChalitoProvider";

const RISK_STYLE: Record<ApprovalView["risk"], string> = {
  LOW: "bg-neutral-100 text-neutral-800",
  MED: "bg-sky-100 text-sky-900",
  HIGH: "bg-amber-100 text-amber-900",
  CRITICAL: "bg-red-100 text-red-900",
};

export const RiskBadge = ({ risk }: { risk: ApprovalView["risk"] }) => {
  const t = useTranslations("live.risk");
  return (
    <span
      data-testid="risk-badge"
      data-risk={risk}
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${RISK_STYLE[risk]}`}
    >
      {t(risk)}
    </span>
  );
};

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** One approval: risk, countdown, opened details, approve/deny (HIGH asks for step-up). */
export const ApprovalCard = ({ a }: { a: ApprovalView }) => {
  const t = useTranslations("live.approval");
  const { client, passkey } = useChalito();
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const expired = a.status === "expired" || (a.status === "pending" && a.expiresAt <= now);
  const pending = a.status === "pending" && !expired;
  // HIGH/CRITICAL approvals need this device's passkey; without one, say so instead of failing.
  const needsPasskey = (a.stepUpRequired || a.risk === "HIGH" || a.risk === "CRITICAL") && !passkey.enrolled;
  const details = a.details as { toolName?: string; summary?: string; reasons?: string[] } | null;

  const decide = async (allow: boolean) => {
    if (!client) return;
    setBusy(true);
    setNote(null);
    try {
      await client.actions.decide(a.aid, allow);
      setNote(t(allow ? "sentAllow" : "sentDeny"));
    } catch (err) {
      const code = err instanceof ActionError ? err.code : "error";
      setNote(
        t(`error.${code === "step_up_cancelled" || code === "expired" || code === "not_pending" ? code : "other"}`),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      data-testid="approval"
      data-aid={a.aid}
      data-status={expired ? "expired" : a.status}
      className="grid gap-2 rounded-xl border bg-white p-4"
    >
      <header className="flex items-center gap-2">
        <RiskBadge risk={a.risk} />
        <span className="font-medium">{details?.toolName ?? t("unknownTool")}</span>
        {pending ? (
          <span data-testid="countdown" className="ml-auto font-mono text-sm tabular-nums" aria-label={t("expiresIn")}>
            {mmss(a.expiresAt - now)}
          </span>
        ) : null}
      </header>
      {details ? (
        <div className="grid gap-1 text-sm">
          <p className="break-words font-mono">{details.summary}</p>
          {details.reasons?.length ? <p className="text-neutral-600">{details.reasons.join(" · ")}</p> : null}
        </div>
      ) : (
        <p className="text-sm text-neutral-600">{t("sealed")}</p>
      )}
      {a.stepUpRequired && pending ? <p className="text-sm text-amber-900">{t("stepUpNeeded")}</p> : null}
      <p data-testid="approval-status" className="text-sm font-medium">
        {expired ? t("expired") : a.status === "pending" ? t("pending") : t(`status.${a.status}`)}
      </p>
      {pending ? (
        <div className="grid gap-2">
          {needsPasskey ? (
            <p data-testid="needs-passkey" className="text-sm text-amber-900">
              {t("needsPasskey")}{" "}
              <Link href="/dispositivos" className="underline">
                {t("enrolPasskey")}
              </Link>
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
              disabled={busy || needsPasskey}
              onClick={() => void decide(true)}
            >
              {t("approve")}
            </button>
            <button
              className="rounded-lg border px-4 py-2 disabled:opacity-50"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              {t("deny")}
            </button>
          </div>
        </div>
      ) : null}
      {note ? (
        <p role="status" className="text-sm">
          {note}
        </p>
      ) : null}
      <Link
        href={{ pathname: "/sesiones/[sid]", params: { sid: a.sid } }}
        className="text-sm text-emerald-700 underline"
      >
        {t("openSession")}
      </Link>
    </article>
  );
};

export const Inbox = () => {
  const t = useTranslations("live.inbox");
  const { approvals, notifications } = useLive();
  const { client } = useChalito();
  const pending = approvals.filter((a) => a.status === "pending");
  const done = approvals.filter((a) => a.status !== "pending");
  const open = notifications.filter((n) => n.state === "pending");
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      {open.length ? (
        <section className="grid gap-2" aria-labelledby="notif-h">
          <h2 id="notif-h" className="font-semibold">
            {t("notifications")}
          </h2>
          {open.map((n) => (
            <div
              key={n.nid}
              data-testid="notification"
              className="flex items-center gap-3 rounded-lg border bg-white p-3 text-sm"
            >
              <span>{t("notification", { count: Object.values(n.counts).reduce((x, y) => x + y, 0) })}</span>
              <button
                className="ml-auto rounded border px-2 py-1"
                onClick={() => void client?.actions.ackNotification(n.nid)}
              >
                {t("ack")}
              </button>
            </div>
          ))}
        </section>
      ) : null}
      <section className="grid gap-3" aria-labelledby="pending-h">
        <h2 id="pending-h" className="font-semibold">
          {t("pending", { count: pending.length })}
        </h2>
        {pending.length ? pending.map((a) => <ApprovalCard key={a.aid} a={a} />) : <p>{t("empty")}</p>}
      </section>
      {done.length ? (
        <section className="grid gap-3" aria-labelledby="done-h">
          <h2 id="done-h" className="font-semibold">
            {t("history")}
          </h2>
          {done.map((a) => (
            <ApprovalCard key={a.aid} a={a} />
          ))}
        </section>
      ) : null}
    </div>
  );
};

/** /a/[id]: one approval, wherever it came from (push, WhatsApp, a call). */
export const ApprovalDeepLink = ({ aid }: { aid: string }) => {
  const t = useTranslations("live.approval");
  const { approvals, status } = useLive();
  const a = approvals.find((x) => x.aid === aid);
  if (a) return <ApprovalCard a={a} />;
  return <p>{status === "live" ? t("notFound") : t("loading")}</p>;
};
