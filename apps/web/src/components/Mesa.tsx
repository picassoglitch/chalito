"use client";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MesaComposer, MesaFeed, MesaInbox, type BrainProvider } from "@chalito/ui";
import {
  MCP_INBOX,
  readInbox,
  readMesa,
  readTurns,
  recentForBrief,
  type InboxItem,
  type MesaLocalState,
  type MesaSource,
  type MesaSummary,
  type MesaTurnView,
} from "@chalito/client";
import type { SessionCard } from "@chalito/protocol";
import { Link, getPathname } from "@/i18n/navigation";
import { newTid } from "@/lib/mesa";
import { useChalito, useLive } from "./ChalitoProvider";
import { NextLinkLike } from "./Mesas";

const APPS: Record<string, BrainProvider> = { "mcp:claude": "anthropic", "mcp:chatgpt": "openai" };

/**
 * /m/[id]: one Mesa. Turns are read under RLS and opened on this device (shown as text only); a
 * new turn sends what the orchestrator's brief needs (goal, card, last 3 turns, the cards of the
 * Mesa's session references), since only the clients can open the history. Pointers on this
 * device's channel refresh the feed.
 */
export const Mesa = ({ mid }: { mid: string }) => {
  const t = useTranslations("settings.mesa");
  const ti = useTranslations("integrations");
  const locale = useLocale() as "es" | "en";
  const { mesa, client } = useChalito();
  const live = useLive();
  const [info, setInfo] = useState<MesaSummary | null | "error" | undefined>(undefined);
  const [turns, setTurns] = useState<MesaTurnView[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [local, setLocal] = useState<MesaLocalState>({ goal: "", card: null });
  const [goalDraft, setGoalDraft] = useState("");
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!mesa) return;
    try {
      const m = await readMesa(mesa.db, mid);
      setInfo(m);
      if (!m) return;
      setTurns(await readTurns(mesa.db, mesa.keys, m));
      setInbox(await readInbox(mesa.db, mesa.keys).catch(() => []));
    } catch {
      setInfo((i) => (i && i !== "error" ? i : "error"));
    }
  }, [mesa, mid]);

  useEffect(() => {
    if (!mesa) return;
    void reload();
    void mesa.state.get(mid).then((s) => s && setLocal(s));
  }, [mesa, mid, reload]);

  // New turns (or inbox posts) arrive as pointers on this device's channel.
  useEffect(() => {
    if (!client) return;
    return client.live.onPointer((table, key) => {
      const m = (key as { mid?: unknown } | null)?.mid;
      // A pointer without a key (or for this Mesa or the inbox): pull again under RLS.
      if ((table === "mesa_turns" || table === "mesas") && (m === undefined || m === mid || m === MCP_INBOX))
        void reload();
    });
  }, [client, mid, reload]);

  // Decision approvals this Mesa raised: from the round's answer, or from the live approvals.
  const decisions = useMemo(() => {
    const out: Record<string, string> = { ...answered };
    for (const a of live.approvals) if (a.mesa?.mid === mid) out[a.mesa.tid] = a.aid;
    return out;
  }, [answered, live.approvals, mid]);

  if (!mesa || info === undefined) return <p aria-live="polite">…</p>;
  if (info === "error") return <p role="alert">{t("errors.load")}</p>;
  if (info === null)
    return (
      <div className="grid gap-2">
        <p role="alert" data-testid="mesa-missing">
          {t("errors.notFound")}
        </p>
        <Link href="/m" className="text-emerald-700 underline">
          {t("back")}
        </Link>
      </div>
    );

  const ownerName = info.participants.find((p) => p.kind === "human")?.name ?? t("you");
  const goal = local.goal || local.card?.goal || "";
  const speakers = info.participants.filter((p) => p.kind === "companion" || p.kind === "brain").map((p) => p.name);
  const appLabel = (origin: string) => (APPS[origin] ? ti(`${APPS[origin]}.name`) : origin);
  const stopped = info.status !== "open";

  const send = async (text: string, source: MesaSource = "owner"): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const sessionCards = info.participants.flatMap((p) => {
      if (p.kind !== "session") return [];
      const card = live.sessions.find((s) => s.sid === p.sid)?.card;
      return card ? [{ sid: p.sid, card: card as SessionCard }] : [];
    });
    const r = await mesa.api.turn(mid, {
      tid: newTid(),
      text,
      source,
      goal: goal.slice(0, 400),
      card: local.card,
      recent: recentForBrief(turns, ownerName),
      sessionCards: sessionCards.slice(0, 4),
      locale,
    });
    if (r.ok) {
      const next = { goal, card: r.card ?? local.card };
      setLocal(next);
      void mesa.state.set(mid, next);
      setAnswered((a) => ({ ...a, ...r.decisions }));
    } else setError(t.has(`errors.${r.stopped ?? r.error}`) ? t(`errors.${r.stopped ?? r.error}`) : t("errors.error"));
    await reload();
    setBusy(false);
    return r.ok;
  };

  const saveGoal = (e: FormEvent) => {
    e.preventDefault();
    const g = goalDraft.trim();
    if (!g) return;
    const next = { ...local, goal: g.slice(0, 240) };
    setLocal(next);
    void mesa.state.set(mid, next);
  };

  return (
    <div className="grid gap-4" data-testid="mesa">
      <Link href="/m" className="w-fit text-sm text-emerald-700 underline">
        {t("back")}
      </Link>
      <h1 className="text-2xl font-bold">
        {info.participants
          .filter((p) => p.kind !== "human")
          .map((p) => p.name)
          .join(" · ")}
      </h1>
      {goal ? (
        <p data-testid="mesa-goal">
          <span className="font-medium">{t("goal")}: </span>
          {goal}
        </p>
      ) : (
        <form onSubmit={saveGoal} className="grid gap-1">
          <label className="text-sm text-neutral-700" htmlFor="mesa-goal">
            {t("goalMissing")}
          </label>
          <div className="flex gap-2">
            <input
              id="mesa-goal"
              className="flex-1 rounded-md border px-3 py-2"
              maxLength={240}
              value={goalDraft}
              placeholder={t("goalPlaceholder")}
              onChange={(e) => setGoalDraft(e.target.value)}
            />
            <button type="submit" className="rounded-md border px-3 py-2">
              {t("goalSave")}
            </button>
          </div>
        </form>
      )}
      <MesaFeed
        turns={turns}
        decisions={decisions}
        approvalHref={(aid) => getPathname({ href: { pathname: "/a/[id]", params: { id: aid } }, locale })}
        sourceLabel={(s) => t(`from.${s}`, { app: appLabel(s) })}
        Link={NextLinkLike}
      />
      {stopped ? (
        <p role="status" data-testid="mesa-stopped" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t(`errors.${info.status}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" data-testid="mesa-error" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">
          {error}
        </p>
      ) : null}
      <MesaComposer names={speakers} disabled={stopped} busy={busy} onSend={(text) => send(text)} />
      <MesaInbox
        items={inbox}
        originLabel={(o) => t("inbox.from", { app: appLabel(o) })}
        disabled={stopped || busy}
        onBring={(tid) => {
          const item = inbox.find((i) => i.tid === tid);
          if (item) void send(item.text, item.origin as MesaSource);
        }}
      />
    </div>
  );
};
