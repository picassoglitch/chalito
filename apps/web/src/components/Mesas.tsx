"use client";
import { useEffect, useState } from "react";
import NextLink from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { MesaList, NewMesaForm, type BrainProvider, type LinkLike, type NewMesaInput } from "@chalito/ui";
import { listMesas, type CreateParticipant, type MesaSummary } from "@chalito/client";
import { getPathname, useRouter } from "@/i18n/navigation";
import { brainName, safeName } from "@/lib/mesa";
import { useChalito, useLive } from "./ChalitoProvider";

export const NextLinkLike: LinkLike = ({ href, className, children, ...rest }) => (
  <NextLink href={href} className={className} {...rest}>
    {children}
  </NextLink>
);

/** Sessions that may sit at a Mesa as references: the live ones (not ended). */
const ENDED = new Set(["ended", "failed", "stopped", "exited"]);

/** /m: the person's Mesas and "Nueva Mesa". */
export const Mesas = () => {
  const t = useTranslations("settings.mesa");
  const ti = useTranslations("integrations");
  const locale = useLocale() as "es" | "en";
  const router = useRouter();
  const { mesa, readCompanion, settings } = useChalito();
  const live = useLive();
  const [list, setList] = useState<MesaSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [companion, setCompanion] = useState<{ id: string; name: string } | null | undefined>(undefined);
  const [limit, setLimit] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mesa) return;
    let alive = true;
    void listMesas(mesa.db)
      .then((l) => alive && setList(l))
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
  }, [mesa]);

  useEffect(() => {
    if (!readCompanion) return;
    let alive = true;
    void (async () => {
      const c = await readCompanion();
      const name = await settings
        ?.load()
        .then((r) => r.values.companionName.name)
        .catch(() => "");
      if (alive) setCompanion(c && c !== "error" ? { id: c.companionId, name: safeName(name ?? "", "Chalito") } : null);
    })();
    return () => {
      alive = false;
    };
  }, [readCompanion, settings]);

  if (!mesa || companion === undefined) return <p aria-live="polite">…</p>;

  const sessions = live.sessions
    .filter((s) => !ENDED.has(s.state ?? ""))
    .map((s) => ({ sid: s.sid, label: s.label || s.card?.label || s.sid }));
  const providerLabel = (p: BrainProvider) => ti(`${p}.name`);

  const create = async (input: NewMesaInput) => {
    setBusy(true);
    setError(null);
    const participants: CreateParticipant[] = [
      ...(input.companion && companion
        ? [{ kind: "companion" as const, pid: "companion", name: companion.name, companionId: companion.id }]
        : []),
      ...input.brains.map((p) => ({
        kind: "brain" as const,
        pid: p,
        name: brainName(providerLabel(p), p),
        provider: p,
      })),
      ...input.sessions.map((sid, i) => {
        const s = sessions.find((x) => x.sid === sid);
        return {
          kind: "session" as const,
          pid: `session${i + 1}`,
          name: safeName(s?.label ?? "", `Sesion ${i + 1}`),
          sid,
        };
      }),
    ];
    const r = await mesa.api.create(participants, t("you"));
    setBusy(false);
    if (!r.ok) {
      if (r.error === "mesa_brains_limit") {
        const n = typeof r.limit === "number" ? r.limit : 0;
        setLimit(n);
        return setError(n > 0 ? t("new.errors.mesa_brains_limit", { n }) : t("new.errors.mesa_brains_none"));
      }
      return setError(t.has(`new.errors.${r.error}`) ? t(`new.errors.${r.error}`) : t("new.errors.error"));
    }
    await mesa.state.set(r.mid, { goal: input.goal, card: null });
    router.push({ pathname: "/m/[id]", params: { id: r.mid } });
  };

  return (
    <div className="grid gap-5" data-testid="mesas">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="text-sm text-neutral-600">{t("intro")}</p>
      <NewMesaForm
        companionName={companion?.name ?? null}
        sessions={sessions}
        brainLimit={limit}
        providerLabel={providerLabel}
        busy={busy}
        error={error}
        onCreate={(i) => void create(i)}
      />
      <section className="grid gap-2">
        <h2 className="font-semibold">{t("list")}</h2>
        {loadError ? (
          <p role="alert">{t("errors.load")}</p>
        ) : list === null ? (
          <p aria-live="polite">…</p>
        ) : (
          <MesaList
            mesas={list}
            hrefOf={(id) => getPathname({ href: { pathname: "/m/[id]", params: { id } }, locale })}
            Link={NextLinkLike}
          />
        )}
      </section>
    </div>
  );
};
