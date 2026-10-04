"use client";
import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ActionError, type EventView, type SessionView } from "@chalito/client";
import type { RemotePermissionMode } from "@chalito/protocol";
import { Link } from "@/i18n/navigation";
import { useChalito, useLive } from "./ChalitoProvider";

/** The only modes a remote surface may set (the device policy is still the ceiling). Never bypassPermissions. */
export const REMOTE_MODES: readonly RemotePermissionMode[] = ["default", "plan", "acceptEdits"];

export const SessionsList = () => {
  const t = useTranslations("live.sessions");
  const { sessions } = useLive();
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
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

const Timeline = ({ events }: { events: readonly EventView[] }) => {
  const t = useTranslations("live.timeline");
  return (
    <ol className="grid gap-2" aria-label={t("label")}>
      {events.map((e) => {
        const body = text(e.content);
        return (
          <li key={e.eid} data-testid="event" data-type={e.type} className="rounded-lg border bg-white p-2 text-sm">
            <span className="font-medium">{t.has(`type.${e.type}`) ? t(`type.${e.type}`) : e.type}</span>
            {body ? <p className="mt-1 whitespace-pre-wrap">{body}</p> : null}
          </li>
        );
      })}
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

const QuestionForm = ({ sid, q }: { sid: string; q: { questionId: string; questions: Question[] } }) => {
  const t = useTranslations("live.session");
  const { client } = useChalito();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  if (sent) return <p role="status">{t("answerSent")}</p>;
  return (
    <form
      data-testid="question"
      className="grid gap-3 rounded-xl border border-sky-300 bg-sky-50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void client?.actions.answer(sid, q.questionId, answers).then(() => setSent(true));
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
  const ts = useTranslations("live.sessions");
  const live = useLive();
  const { client } = useChalito();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const s: SessionView | undefined = live.sessions.find((x) => x.sid === sid);
  const events = live.events[sid] ?? [];
  if (!s) return <p>{live.status === "live" ? t("notFound") : t("loading")}</p>;
  const card = s.card;
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
        <p className="text-sm text-neutral-600">{t("sealed")}</p>
      )}
      {pendingQuestions.map((q) => (
        <QuestionForm key={q.questionId} sid={sid} q={q} />
      ))}
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
      {note ? <p role="status">{note}</p> : null}
      <Timeline events={events} />
    </div>
  );
};
