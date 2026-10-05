import { useId, useState, type ComponentType, type FormEvent, type ReactNode } from "react";
import { useUiText } from "./text.js";

/**
 * Mesa screens (M9), shared by the PWA and (later) the desktop. Props only: the shell reads and
 * opens the Mesa with @chalito/client and passes plain views and callbacks. Everything a turn
 * says is quoted TEXT, never markup and never instructions. Strings live under `settings.mesa`.
 * Provider names come from the shell (`providerLabel`, its `integrations.*` strings).
 */

export type BrainProvider = "anthropic" | "openai" | "xai" | "google";
export const MESA_BRAINS: readonly BrainProvider[] = ["anthropic", "openai", "xai", "google"];

export type MesaPerson =
  | { kind: "human"; pid: string; name: string }
  | { kind: "companion"; pid: string; name: string }
  | { kind: "brain"; pid: string; name: string; provider: BrainProvider }
  | { kind: "session"; pid: string; name: string };

/** A link component (Next's Link on the web); defaults to <a>. */
export type LinkLike = ComponentType<{ href: string; className?: string; children: ReactNode; "data-testid"?: string }>;
const A: LinkLike = ({ href, className, children, ...rest }) => (
  <a href={href} className={className} {...rest}>
    {children}
  </a>
);

// ---- list -------------------------------------------------------------------------------

export interface MesaListItem {
  mid: string;
  participants: readonly MesaPerson[];
  status: "open" | "budget_reached" | "closed";
  createdAt: number;
}

export const MesaList = ({
  mesas,
  hrefOf,
  Link = A,
}: {
  mesas: readonly MesaListItem[];
  hrefOf: (mid: string) => string;
  Link?: LinkLike;
}) => {
  const { t, locale } = useUiText();
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  if (!mesas.length) return <p className="text-sm text-neutral-600">{t("mesa.listEmpty")}</p>;
  return (
    <ul className="grid gap-2" aria-label={t("mesa.list")}>
      {mesas.map((m) => (
        <li key={m.mid}>
          <Link
            href={hrefOf(m.mid)}
            data-testid="mesa-link"
            className="grid gap-1 rounded-lg border bg-white p-3 hover:border-emerald-600"
          >
            <span className="font-medium">
              {m.participants
                .filter((p) => p.kind !== "human")
                .map((p) => p.name)
                .join(" · ")}
            </span>
            <span className="flex gap-2 text-xs text-neutral-600">
              <time dateTime={new Date(m.createdAt).toISOString()}>{date.format(m.createdAt)}</time>
              {m.status !== "open" ? <span data-testid="mesa-status">{t(`mesa.status.${m.status}`)}</span> : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
};

// ---- new Mesa -----------------------------------------------------------------------------

export interface NewMesaInput {
  companion: boolean;
  brains: BrainProvider[];
  sessions: string[];
  goal: string;
}

export const MESA_MAX_SESSIONS = 2;

export const NewMesaForm = ({
  companionName,
  sessions,
  brainLimit,
  providerLabel,
  busy,
  error,
  onCreate,
}: {
  /** This person's companion, or null when they don't have one yet. */
  companionName: string | null;
  /** Live sessions that may be referenced (their cards are quoted as data). */
  sessions: readonly { sid: string; label: string }[];
  /** The plan's brains per Mesa (limits.mesaBrains), once known; null = not known yet. */
  brainLimit: number | null;
  providerLabel: (p: BrainProvider) => string;
  busy: boolean;
  error: string | null;
  onCreate: (input: NewMesaInput) => void;
}) => {
  const { t } = useUiText();
  const id = useId();
  const [companion, setCompanion] = useState(companionName !== null);
  const [brains, setBrains] = useState<BrainProvider[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [goal, setGoal] = useState("");
  const atLimit = brainLimit !== null && brains.length >= brainLimit;
  const nobody = !companion && brains.length === 0;
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || nobody) return;
    onCreate({ companion, brains, sessions: picked, goal: goal.trim() });
  };
  return (
    <form onSubmit={submit} className="grid gap-4 rounded-xl border bg-white p-4" data-testid="new-mesa">
      <h2 className="font-semibold">{t("mesa.new.title")}</h2>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t("mesa.new.who")}</legend>
        {companionName !== null ? (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={companion} onChange={(e) => setCompanion(e.target.checked)} />
            {t("mesa.new.companion", { name: companionName })}
          </label>
        ) : (
          <p className="text-sm text-neutral-600">{t("mesa.new.noCompanion")}</p>
        )}
        {MESA_BRAINS.map((p) => {
          const on = brains.includes(p);
          return (
            <label key={p} className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid={`mesa-brain-${p}`}
                checked={on}
                disabled={!on && atLimit}
                onChange={() => setBrains((b) => toggle(b, p))}
              />
              {providerLabel(p)}
            </label>
          );
        })}
        <p className="text-xs text-neutral-600" data-testid="mesa-brain-limit">
          {brainLimit === null
            ? t("mesa.new.limitUnknown")
            : brainLimit === 0
              ? t("mesa.new.limitNone")
              : t("mesa.new.limit", { n: brainLimit })}
        </p>
      </fieldset>
      {sessions.length ? (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{t("mesa.new.sessions", { n: MESA_MAX_SESSIONS })}</legend>
          {sessions.map((s) => {
            const on = picked.includes(s.sid);
            return (
              <label key={s.sid} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!on && picked.length >= MESA_MAX_SESSIONS}
                  onChange={() => setPicked((x) => toggle(x, s.sid))}
                />
                {s.label}
              </label>
            );
          })}
          <p className="text-xs text-neutral-600">{t("mesa.new.sessionsNote")}</p>
        </fieldset>
      ) : null}
      <label className="grid gap-1" htmlFor={`${id}-goal`}>
        <span className="text-sm font-medium">{t("mesa.goal")}</span>
        <input
          id={`${id}-goal`}
          className="rounded-md border px-3 py-2"
          maxLength={240}
          value={goal}
          placeholder={t("mesa.goalPlaceholder")}
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>
      {error ? (
        <p role="alert" data-testid="mesa-error" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy || nobody}
        className="w-fit rounded-md bg-emerald-700 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {t("mesa.new.create")}
      </button>
    </form>
  );
};

// ---- the feed ----------------------------------------------------------------------------

export interface MesaFeedTurn {
  tid: string;
  t: number;
  speaker: MesaPerson | null;
  text: string | null;
  /** Input turns forwarded from an app or a room ("owner" = the person's own words). */
  source: "owner" | "mcp:claude" | "mcp:chatgpt" | "room" | null;
  emotion: { tag: string; intensity: number };
  proposals: readonly string[];
  objections: readonly string[];
  decision: { question: string; options: readonly string[] } | null;
  energy: { chip: { label: string; href: string } } | null;
  billing: "managed" | "byo" | "free_min" | null;
}

/** packages/protocol EmotionTag; anything else gets no chip. */
const EMOTIONS = new Set(["happy", "angry", "sad", "relaxed", "surprised", "excited", "tired", "thinking", "worried"]);

export const MesaFeed = ({
  turns,
  decisions,
  approvalHref,
  sourceLabel,
  Link = A,
}: {
  turns: readonly MesaFeedTurn[];
  /** tid → aid of the decision approval that turn raised. */
  decisions: Readonly<Record<string, string>>;
  approvalHref: (aid: string) => string;
  /** "Reenviado desde {app}" for forwarded input. */
  sourceLabel: (source: "mcp:claude" | "mcp:chatgpt" | "room") => string;
  Link?: LinkLike;
}) => {
  const { t, locale } = useUiText();
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  if (!turns.length) return <p className="text-sm text-neutral-600">{t("mesa.empty")}</p>;
  return (
    <ol className="grid gap-2" aria-label={t("mesa.feed")} aria-live="polite">
      {turns.map((x) => {
        const mine = x.speaker?.kind === "human";
        const aid = decisions[x.tid];
        return (
          <li
            key={x.tid}
            data-testid="mesa-turn"
            data-tid={x.tid}
            className={`grid gap-1 rounded-lg border p-3 ${mine ? "bg-emerald-50" : "bg-white"}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
              <span className="font-medium" data-testid="mesa-speaker">
                {mine ? t("mesa.you") : (x.speaker?.name ?? t("mesa.unknownSpeaker"))}
              </span>
              {x.source && x.source !== "owner" ? <span>{sourceLabel(x.source)}</span> : null}
              {!mine && EMOTIONS.has(x.emotion.tag) ? (
                <span data-testid="mesa-emotion" className="rounded-full bg-neutral-100 px-2 py-0.5">
                  {t(`mesa.emotion.${x.emotion.tag}`)}
                </span>
              ) : null}
              {x.billing === "byo" ? <span data-testid="mesa-byo">{t("mesa.byo")}</span> : null}
              <time className="ml-auto" dateTime={new Date(x.t).toISOString()}>
                {time.format(x.t)}
              </time>
            </div>
            {x.text === null ? (
              <p className="text-sm italic text-neutral-500">{t("mesa.sealed")}</p>
            ) : (
              // Quoted data: rendered as text (React escapes it), whitespace kept, never HTML.
              <blockquote data-testid="mesa-turn-text" className="whitespace-pre-wrap break-words">
                {x.text}
              </blockquote>
            )}
            {x.proposals.length ? (
              <ul className="list-disc pl-5 text-sm" aria-label={t("mesa.proposals")}>
                {x.proposals.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            ) : null}
            {x.objections.length ? (
              <ul className="list-disc pl-5 text-sm text-amber-900" aria-label={t("mesa.objections")}>
                {x.objections.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            ) : null}
            {x.energy ? (
              <Link
                href={x.energy.chip.href}
                data-testid="mesa-recharge"
                className="w-fit rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900"
              >
                {x.energy.chip.label || t("mesa.recharge")}
              </Link>
            ) : null}
            {x.decision ? (
              <div className="grid gap-1 rounded-md bg-neutral-50 p-2 text-sm" data-testid="mesa-decision">
                <p className="font-medium">{x.decision.question}</p>
                <p className="text-neutral-700">{x.decision.options.join(" · ")}</p>
                {aid ? (
                  <Link
                    href={approvalHref(aid)}
                    data-testid="mesa-decision-link"
                    className="w-fit text-emerald-700 underline"
                  >
                    {t("mesa.decide")}
                  </Link>
                ) : (
                  <p className="text-xs text-neutral-600">{t("mesa.decisionForwarded")}</p>
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
};

// ---- composer with @mentions --------------------------------------------------------------

/** The @word being typed at the end of the text, if any. */
const mentionAt = (text: string) => /(^|\s)@([\p{L}\p{N}._'-]*)$/u.exec(text);

export const MesaComposer = ({
  names,
  disabled,
  busy,
  onSend,
}: {
  /** Who can be addressed (companion and brains), by their Mesa names. */
  names: readonly string[];
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => Promise<boolean>;
}) => {
  const { t } = useUiText();
  const id = useId();
  const [text, setText] = useState("");
  const m = mentionAt(text);
  const all = t("mesa.everyone");
  const suggestions = m
    ? [...names, all].filter((n) => n.toLowerCase().startsWith(m[2]!.toLowerCase())).slice(0, 6)
    : [];
  const pick = (n: string) => setText((s) => s.replace(/@[\p{L}\p{N}._'-]*$/u, `@${n} `));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v || busy || disabled) return;
    if (await onSend(v)) setText("");
  };
  return (
    <form onSubmit={submit} className="grid gap-2">
      <label htmlFor={`${id}-text`} className="text-sm font-medium">
        {t("mesa.composer")}
      </label>
      <textarea
        id={`${id}-text`}
        data-testid="mesa-composer"
        className="min-h-20 rounded-md border px-3 py-2"
        maxLength={4000}
        value={text}
        disabled={disabled}
        placeholder={t("mesa.composerHint")}
        onChange={(e) => setText(e.target.value)}
      />
      {suggestions.length ? (
        <ul className="flex flex-wrap gap-2" aria-label={t("mesa.mentions")}>
          {suggestions.map((n) => (
            <li key={n}>
              <button
                type="button"
                data-testid="mesa-mention"
                className="rounded-full border px-3 py-1 text-sm"
                onClick={() => pick(n)}
              >
                @{n}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="submit"
        disabled={disabled || busy || !text.trim()}
        className="w-fit rounded-md bg-emerald-700 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {busy ? t("mesa.thinking") : t("mesa.send")}
      </button>
    </form>
  );
};

// ---- the MCP inbox --------------------------------------------------------------------------

export const MesaInbox = ({
  items,
  originLabel,
  disabled,
  onBring,
}: {
  items: readonly { tid: string; t: number; origin: string; text: string }[];
  originLabel: (origin: string) => string;
  disabled: boolean;
  onBring: (tid: string) => void;
}) => {
  const { t } = useUiText();
  if (!items.length) return null;
  return (
    <details className="rounded-lg border bg-white p-3" data-testid="mesa-inbox">
      <summary className="cursor-pointer font-medium">{t("mesa.inbox.title", { n: items.length })}</summary>
      <p className="mt-1 text-xs text-neutral-600">{t("mesa.inbox.note")}</p>
      <ul className="mt-2 grid gap-2">
        {items.map((i) => (
          <li key={i.tid} className="grid gap-1 border-t pt-2" data-testid="mesa-inbox-item">
            <span className="text-xs text-neutral-600">{originLabel(i.origin)}</span>
            <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-2 text-sm">{i.text}</blockquote>
            <button
              type="button"
              disabled={disabled}
              className="w-fit text-sm text-emerald-700 underline disabled:opacity-50"
              onClick={() => onBring(i.tid)}
            >
              {t("mesa.inbox.bring")}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
};

// ---- "Tus claves" (BYO brain keys) ----------------------------------------------------------

export const BrainKeysPanel = ({
  rows,
  providerLabel,
  busy,
  note,
  onSave,
  onDelete,
}: {
  rows: readonly { provider: BrainProvider; hint: string; cloud: boolean }[] | null;
  providerLabel: (p: BrainProvider) => string;
  busy: boolean;
  note: string | null;
  onSave: (provider: BrainProvider, key: string, cloud: boolean) => Promise<boolean>;
  onDelete: (provider: BrainProvider) => void;
}) => {
  const { t } = useUiText();
  const id = useId();
  const [provider, setProvider] = useState<BrainProvider>("anthropic");
  const [key, setKey] = useState("");
  const [cloud, setCloud] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (k.length < 8 || busy) return;
    if (await onSave(provider, k, cloud)) {
      setKey("");
      setCloud(false);
    }
  };
  return (
    <section className="grid gap-3" aria-labelledby={`${id}-h`} data-testid="brain-keys">
      <h2 id={`${id}-h`} className="text-lg font-semibold">
        {t("mesa.keys.title")}
      </h2>
      <p className="text-sm text-neutral-700">{t("mesa.keys.intro")}</p>
      {rows === null ? (
        <p className="text-sm text-neutral-600">{t("mesa.keys.loading")}</p>
      ) : rows.length ? (
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.provider} className="flex flex-wrap items-center gap-2" data-testid="brain-key">
              <span className="font-medium">{providerLabel(r.provider)}</span>
              {r.hint ? <code className="text-xs">…{r.hint}</code> : null}
              <span className="text-xs text-neutral-600">
                {r.cloud ? t("mesa.keys.cloudOn") : t("mesa.keys.cloudOff")}
              </span>
              <button
                type="button"
                disabled={busy}
                className="ml-auto text-sm text-red-800 underline"
                onClick={() => onDelete(r.provider)}
              >
                {t("mesa.keys.remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-600">{t("mesa.keys.none")}</p>
      )}
      <form onSubmit={submit} className="grid gap-2 rounded-xl border bg-white p-4">
        <label className="grid gap-1" htmlFor={`${id}-p`}>
          <span className="text-sm font-medium">{t("mesa.keys.provider")}</span>
          <select
            id={`${id}-p`}
            className="rounded-md border px-3 py-2"
            value={provider}
            onChange={(e) => setProvider(e.target.value as BrainProvider)}
          >
            {MESA_BRAINS.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1" htmlFor={`${id}-k`}>
          <span className="text-sm font-medium">{t("mesa.keys.key")}</span>
          <input
            id={`${id}-k`}
            data-testid="brain-key-input"
            type="password"
            autoComplete="off"
            className="rounded-md border px-3 py-2"
            minLength={8}
            maxLength={512}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            data-testid="brain-key-cloud"
            checked={cloud}
            onChange={(e) => setCloud(e.target.checked)}
          />
          <span className="text-sm">{t("mesa.keys.cloud")}</span>
        </label>
        {cloud ? (
          <p
            role="note"
            data-testid="brain-key-warning"
            className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {t("mesa.keys.cloudWarning")}
          </p>
        ) : (
          <p className="text-xs text-neutral-600">{t("mesa.keys.localOnly")}</p>
        )}
        <button
          type="submit"
          disabled={busy || key.trim().length < 8}
          className="w-fit rounded-md bg-emerald-700 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {t("mesa.keys.save")}
        </button>
      </form>
      {note ? (
        <p role="status" data-testid="brain-key-note" className="text-sm">
          {note}
        </p>
      ) : null}
    </section>
  );
};

// ---- a Mesa decision on /a/<aid> -------------------------------------------------------------

export const MesaDecisionCard = ({
  from,
  question,
  options,
  busy,
  done,
  onPick,
  onDismiss,
}: {
  from: string;
  question: string;
  options: readonly string[];
  busy: boolean;
  /** Set once answered (or resolved elsewhere). */
  done: string | null;
  onPick: (choice: number) => void;
  onDismiss: () => void;
}) => {
  const { t } = useUiText();
  return (
    <div className="grid gap-3 rounded-xl border bg-white p-4" data-testid="mesa-decision-card">
      <p className="text-xs text-neutral-600">{t("mesa.decision.from", { name: from || t("mesa.unknownSpeaker") })}</p>
      {/* Quoted data from a participant: text only. */}
      <p className="whitespace-pre-wrap break-words font-medium" data-testid="mesa-decision-question">
        {question}
      </p>
      {done ? (
        <p role="status" data-testid="mesa-decision-done">
          {done}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {options.map((o, i) => (
              <button
                key={i}
                type="button"
                data-testid="mesa-decision-option"
                disabled={busy}
                className="rounded-md border border-emerald-700 px-3 py-2 text-emerald-800 disabled:opacity-50"
                onClick={() => onPick(i)}
              >
                {o}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={busy}
            className="w-fit text-sm text-neutral-700 underline"
            onClick={onDismiss}
          >
            {t("mesa.decision.none")}
          </button>
          <p className="text-xs text-neutral-600">{t("mesa.decision.note")}</p>
        </>
      )}
    </div>
  );
};
