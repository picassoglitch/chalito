"use client";
import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ActionError, linkEventLine, type DraftView, type EventView, type SessionView } from "@chalito/client";
import { sessionLink, type RemotePermissionMode } from "@chalito/protocol";
import { Link } from "@/i18n/navigation";
import { useChalito, useLive } from "./ChalitoProvider";
import { SharingToggle } from "./SharingToggle";
import { ApprovalCard } from "./Approvals";

/** The only modes a remote surface may set (the device policy is still the ceiling). Never bypassPermissions. */
export const REMOTE_MODES: readonly RemotePermissionMode[] = ["default", "plan", "acceptEdits"];

export const SessionsList = () => {
  const t = useTranslations("live.sessions");
  const { sessions } = useLive();
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <Link href="/sesiones/nueva" className="rounded-lg bg-emerald-700 px-4 py-2 text-white">
          {t("new")}
        </Link>
      </div>
      {sessions.length === 0 ? <p>{t("empty")}</p> : null}
      <ul className="grid gap-3">
        {sessions.map((s) => (
          <li key={s.sid} data-testid="session-row">
            <Link
              href={{ pathname: "/sesiones/[sid]", params: { sid: s.sid } }}
              className="grid gap-1 rounded-xl border bg-white p-4"
            >
              <span className="font-medium">{s.card?.goal ?? s.label ?? s.sid}</span>
              <span className="text-sm text-neutral-600">
                {s.card?.workspaceLabel ?? s.label} · {t(`state.${s.card?.state ?? s.state ?? "starting"}`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
};

const text = (c: unknown): string | null =>
  c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
    ? (c as { text: string }).text
    : null;

interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
}

/** A hand-off or share between agents (ADR 0022 §3): direction, stage and hop; shared content as quoted data. */
const LinkLine = ({ e }: { e: EventView }) => {
  const t = useTranslations("live.timeline.link");
  const line = linkEventLine(e);
  if (!line) return null;
  if (line.kind === "handoff")
    return (
      <p className="mt-1 text-neutral-600" data-testid="link-line">
        {t(line.direction)} · {t(`stage.${line.stage}`)} · {t("hop", { hop: line.hop })}
        {line.reason ? ` (${line.reason})` : null}
      </p>
    );
  return (
    <blockquote className="mt-1 border-l-2 pl-2 text-neutral-600" data-testid="link-line">
      <p className="text-xs">{t("quoted")}</p>
      {line.content ? <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(line.content, null, 2)}</pre> : null}
    </blockquote>
  );
};

const Timeline = ({ events, draft }: { events: readonly EventView[]; draft?: DraftView | undefined }) => {
  const t = useTranslations("live.timeline");
  return (
    <ol className="grid gap-2" aria-label={t("label")}>
      {events.map((e) => {
        const body = text(e.content);
        return (
          <li key={e.eid} data-testid="event" data-type={e.type} className="rounded-lg border bg-white p-2 text-sm">
            {/* Message keys can't contain "." (next-intl nesting): session.started → session_started. */}
            <span className="font-medium">
              {t.has(`type.${e.type.replace(/\./g, "_")}`) ? t(`type.${e.type.replace(/\./g, "_")}`) : e.type}
            </span>
            <LinkLine e={e} />
            {body ? <p className="mt-1 whitespace-pre-wrap">{body}</p> : null}
          </li>
        );
      })}
      {/* M16 A: the reply being written, from live deltas; replaced by the stored message. */}
      {draft ? (
        <li
          data-testid="draft"
          data-type="message.assistant.delta"
          aria-live="polite"
          className="rounded-lg border border-dashed bg-white p-2 text-sm"
        >
          <span className="font-medium">{t("draft")}</span>
          <p className="mt-1 whitespace-pre-wrap">{draft.text}</p>
        </li>
      ) : null}
    </ol>
  );
};

/** Open agent questions: the last question.asked not followed by our answer. */
const openQuestions = (events: readonly EventView[]) => {
  const out: { questionId: string; questions: Question[] }[] = [];
  for (const e of events) {
    if (e.type === "question.asked" && Array.isArray(e.content))
      out.push({ questionId: String(e.meta.questionId), questions: e.content as Question[] });
  }
  return out;
};

const QuestionForm = ({
  sid,
  q,
  onSent,
}: {
  sid: string;
  q: { questionId: string; questions: Question[] };
  onSent: () => void;
}) => {
  const t = useTranslations("live.session");
  const { client } = useChalito();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <form
      data-testid="question"
      className="grid gap-3 rounded-xl border border-sky-300 bg-sky-50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        // The agent clears the open question once it has the answer, unmounting this form;
        // the confirmation lives in the session view.
        void client?.actions.answer(sid, q.questionId, answers).then(onSent);
      }}
    >
      {q.questions.map((qq) => (
        <fieldset key={qq.question} className="grid gap-1">
          <legend className="font-medium">{qq.question}</legend>
          {qq.options.map((o) => (
            <label key={o.label} className="flex items-center gap-2">
              <input
                type="radio"
                name={qq.question}
                checked={answers[qq.question] === o.label}
                onChange={() => setAnswers({ ...answers, [qq.question]: o.label })}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
      ))}
      <button
        className="w-fit rounded-lg bg-sky-700 px-4 py-2 text-white"
        disabled={Object.keys(answers).length < q.questions.length}
      >
        {t("answer")}
      </button>
    </form>
  );
};

export const SessionDetail = ({ sid }: { sid: string }) => {
  const t = useTranslations("live.session");
  const locale = useLocale() === "en" ? "en" : "es";
  const ts = useTranslations("live.sessions");
  const live = useLive();
  const { client } = useChalito();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [showLink, setShowLink] = useState(false);
  const link = showLink && typeof window !== "undefined" ? sessionLink(sid, locale) : null;
  const s: SessionView | undefined = live.sessions.find((x) => x.sid === sid);
  const events = live.events[sid] ?? [];
  if (!s) return <p>{live.status === "live" ? t("notFound") : t("loading")}</p>;
  const card = s.card;
  const approvalOnly = s.control === "approvals";
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setNote(null);
    try {
      await f();
      setNote(t(ok));
    } catch (err) {
      setNote(err instanceof ActionError && err.code === "untrusted_agent" ? t("untrusted") : t("failed"));
    }
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    const msg = draft.trim();
    if (!msg || !client) return;
    setDraft("");
    if (msg === "/link") {
      setShowLink(true);
      return;
    }
    void run(() => client.actions.prompt(sid, msg), "sent");
  };
  const pendingQuestions = card?.openQuestion ? openQuestions(events).slice(-1) : [];

  return (
    <div className="grid gap-5">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold">{card?.goal ?? s.label ?? sid}</h1>
        <p className="text-sm text-neutral-600">
          {card?.workspaceLabel ?? s.label} ·{" "}
          <span data-testid="session-state">{ts(`state.${card?.state ?? s.state ?? "starting"}`)}</span>
        </p>
      </header>
      <div>
        <button type="button" className="rounded-lg border px-3 py-1" onClick={() => setShowLink(true)}>
          {t("link")}
        </button>
        {link && (
          <p className="break-all text-sm">
            <a href={link} className="underline">
              {link}
            </a>
            <br />
            {t("linkHint")}
          </p>
        )}
      </div>
      {card ? (
        <dl data-testid="session-card" className="grid grid-cols-2 gap-2 rounded-xl border bg-white p-4 text-sm">
          {card.lastAction ? (
            <>
              <dt className="text-neutral-600">{t("card.lastAction")}</dt>
              <dd>{card.lastAction}</dd>
            </>
          ) : null}
          <dt className="text-neutral-600">{t("card.pendingApprovals")}</dt>
          <dd>{card.pendingApprovals}</dd>
          <dt className="text-neutral-600">{t("card.filesTouched")}</dt>
          <dd data-testid="files-touched">{card.filesTouched}</dd>
          {card.tests ? (
            <>
              <dt className="text-neutral-600">{t("card.tests")}</dt>
              <dd>{t("card.testsValue", { passed: card.tests.passed, failed: card.tests.failed })}</dd>
            </>
          ) : null}
          {card.blockers.length ? (
            <>
              <dt className="text-neutral-600">{t("card.blockers")}</dt>
              <dd>{card.blockers.join(" · ")}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        !approvalOnly && <p className="text-sm text-neutral-600">{t("sealed")}</p>
      )}
      <SharingToggle scope="session" target={sid} />
      {live.approvals
        ?.filter((a) => a.sid === sid && a.status === "pending")
        .map((a) => (
          <ApprovalCard key={a.aid} a={a} />
        ))}
      {approvalOnly && <p className="text-sm text-neutral-600">{t("nativeScope")}</p>}
      {pendingQuestions.map((q) => (
        <QuestionForm key={q.questionId} sid={sid} q={q} onSent={() => setNote(t("answerSent"))} />
      ))}
      {!approvalOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-lg border px-3 py-1"
            onClick={() => client && void run(() => client.actions.interrupt(sid), "interrupted")}
          >
            {t("interrupt")}
          </button>
          <button
            className="rounded-lg border px-3 py-1"
            onClick={() => client && void run(() => client.actions.resume(sid), "resumed")}
          >
            {t("resume")}
          </button>
          <label className="ml-auto flex items-center gap-2 text-sm">
            {t("mode")}
            <select
              data-testid="permission-mode"
              className="rounded border px-2 py-1"
              value={s.permissionMode ?? "default"}
              onChange={(e) =>
                client &&
                void run(() => client.actions.setPermissionMode(sid, e.target.value as RemotePermissionMode), "modeSet")
              }
            >
              {REMOTE_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`modes.${m}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {!approvalOnly && (
        <form onSubmit={send} className="flex gap-2">
          <label htmlFor="prompt" className="sr-only">
            {t("prompt")}
          </label>
          <input
            id="prompt"
            className="flex-1 rounded-lg border px-3 py-2"
            placeholder={t("promptPlaceholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="rounded-lg bg-emerald-700 px-4 py-2 text-white">{t("send")}</button>
        </form>
      )}
      {note ? <p role="status">{note}</p> : null}
      <Timeline events={events} draft={live.drafts[sid]} />
    </div>
  );
};
