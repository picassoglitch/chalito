"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  attestationOk,
  checkPhoto,
  isActive,
  newCreationId,
  type AgeBand,
  type Attestation,
  type Creation,
  type CreationFailure,
  type KeptCharacter,
  type PhotoType,
  type Quote,
} from "@/lib/avatar";
import { useChalito } from "./ChalitoProvider";
import { useMyCard } from "./useMyCard";

const EMOTIONS = ["neutral", "happy", "sad", "surprised", "tired"] as const;
const POLL_MS = 3000;

type Phase =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "working"; creation: Creation }
  | { kind: "done"; creation: Creation; used: boolean }
  | { kind: "failed"; failure: CreationFailure | "expired" | "upload"; charged: false };

/** What happened to the last "Eliminar mi personaje". */
type DeleteNote = "done" | "inFlight" | "retry" | "error";

type Note =
  | "noTokens"
  | "busy"
  | "dailyLimit"
  | "retry"
  | "badType"
  | "badSize"
  | "useError"
  | "noCompanion"
  | "ageRefused"
  | "guardianRequired"
  | "attestationRequired";

const AGE_BANDS: readonly AgeBand[] = ["18_plus", "13_17", "under_13"];

export interface OnboardingHooks {
  /** Creates (or saves) the companion with the roster avatar picked so far; false if that failed. */
  ensureCompanion: () => Promise<boolean>;
  /** A creation started: onboarding keeps its avatar choice from now on. */
  onStarted?: () => void;
}

/**
 * "Crea tu personaje": a photo of the person becomes their own companion in the Chalito style, with
 * the same five drawings as every roster character (/v1/avatar). Shown under the companion picker.
 * The first one is free; later ones show their price in tokens. A tap makes one creationId and
 * reuses it on retry, so a retry never charges twice. Failures are never charged.
 *
 * Before any upload the person confirms the photo is of themselves and their age (13+, and at
 * 13–17 a parent's or guardian's permission); under 13 can't create. The api checks it again.
 *
 * In onboarding (`onboarding`), the companion is saved first with the roster avatar picked so far,
 * and the creation is started with useWhenReady: the server puts the card on the companion the
 * moment it succeeds, so the person can carry on with the next steps while it's drawn.
 *
 * "Tus personajes" lists the characters the person kept, each with "Eliminar mi personaje" behind an
 * in-page confirmation (permanent; the drawings go; no tokens or free creation back). Deleting the
 * one the companion wears puts its roster avatar back everywhere (the card source is refreshed).
 */
export const CreateCharacter = ({ onboarding }: { onboarding?: OnboardingHooks } = {}) => {
  const t = useTranslations("createCharacter");
  const locale = useLocale();
  const { avatar } = useChalito();
  const mine = useMyCard();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [note, setNote] = useState<{ kind: Note; chipHref?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [attest, setAttest] = useState<Attestation>({ ownPhoto: false, ageBand: null, guardianConsent: false });
  const pending = useRef<string | null>(null);
  const [kept, setKept] = useState<KeptCharacter[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleteNote, setDeleteNote] = useState<DeleteNote | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!avatar) return;
    const [q, k] = await Promise.all([avatar.quote(), avatar.kept()]);
    if (k !== "error") setKept(k);
    if (q === "error") return;
    setQuote(q);
    if (q.active && isActive(q.active.status)) setPhase({ kind: "working", creation: q.active });
  }, [avatar]);

  // The confirmation step takes the focus, so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  useEffect(() => void load(), [load]);

  // The photo preview lives only in this tab (an object URL), never uploaded until "Crear".
  useEffect(() => {
    if (!photo) return setPreview(null);
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  // Poll while the job works.
  const working = phase.kind === "working" ? phase.creation.creationId : null;
  useEffect(() => {
    if (!avatar || !working) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const c = await avatar.status(working);
      if (!alive) return;
      if (c !== "error" && !isActive(c.status)) {
        pending.current = null;
        if (c.status === "succeeded") {
          setPhase({ kind: "done", creation: c, used: false });
          // Onboarding asked the server to put it on already; saying so again is harmless.
          if (onboarding)
            void avatar
              .use(c.creationId)
              .then((r) => r === "ok" && setPhase({ kind: "done", creation: c, used: true }));
        } else setPhase({ kind: "failed", failure: c.failure ?? "expired", charged: false });
        void load();
        return;
      }
      if (c !== "error") setPhase((p) => (p.kind === "working" ? { kind: "working", creation: c } : p));
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [avatar, working, load, onboarding]);

  if (!avatar || !quote) return null;

  const pick = (f: File | null) => {
    setNote(null);
    if (!f) return setPhoto(null);
    const ok = checkPhoto(f);
    if (ok !== "ok") {
      setPhoto(null);
      return setNote({ kind: ok === "type" ? "badType" : "badSize" });
    }
    setPhoto(f);
  };

  const create = async () => {
    if (!photo || !attestationOk(attest)) return;
    setBusy(true);
    setNote(null);
    if (onboarding && !(await onboarding.ensureCompanion())) {
      setBusy(false);
      return setNote({ kind: "retry" });
    }
    pending.current ??= newCreationId();
    const r = await avatar.start(pending.current, photo.type as PhotoType, attest, {
      useWhenReady: onboarding !== undefined,
    });
    if (!r.ok) {
      setBusy(false);
      if (r.reason === "retry") return setNote({ kind: "retry" });
      pending.current = null;
      if (r.reason === "age_refused") return setNote({ kind: "ageRefused" });
      if (r.reason === "guardian_required") return setNote({ kind: "guardianRequired" });
      if (r.reason === "attestation_required") return setNote({ kind: "attestationRequired" });
      if (r.reason === "no_tokens") return setNote({ kind: "noTokens", chipHref: r.chipHref });
      if (r.reason === "busy") return setNote({ kind: "busy" });
      if (r.reason === "daily_limit") return setNote({ kind: "dailyLimit" });
      return setNote({ kind: "retry" });
    }
    onboarding?.onStarted?.();
    setPhase({ kind: "uploading" });
    const sent = await avatar.upload(r.upload, photo);
    if (!sent) {
      setBusy(false);
      setPhase({ kind: "idle" });
      return setNote({ kind: "retry" });
    }
    const c = await avatar.uploaded(r.creation.creationId);
    setBusy(false);
    setPhoto(null);
    setPhase({ kind: "working", creation: c === "error" ? r.creation : c });
  };

  const use = async (creation: Creation) => {
    setBusy(true);
    setNote(null);
    const r = await avatar.use(creation.creationId);
    setBusy(false);
    if (r === "ok") {
      setPhase({ kind: "done", creation, used: true });
      // Everywhere the companion is drawn picks the new card up.
      void mine.refresh();
      void load();
    } else setNote({ kind: r === "no_companion" ? "noCompanion" : "useError" });
  };

  const remove = async (creationId: string) => {
    setBusy(true);
    setDeleteNote(null);
    const r = await avatar.remove(creationId);
    setBusy(false);
    if (r === "ok") {
      setConfirming(null);
      setDeleteNote("done");
      setKept((k) => k.filter((x) => x.creationId !== creationId));
      setPhase((p) => (p.kind === "done" && p.creation.creationId === creationId ? { kind: "idle" } : p));
      // The companion may have worn it: everywhere it's drawn goes back to the roster avatar.
      void mine.refresh();
      void load();
    } else setDeleteNote(r === "in_flight" ? "inFlight" : r);
  };

  const tokens = new Intl.NumberFormat(locale);
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const under13 = attest.ageBand === "under_13";
  const card = phase.kind === "done" ? phase.creation.card : undefined;
  return (
    <section
      aria-labelledby="create-character-title"
      data-testid="create-character"
      className="mt-3 grid gap-3 rounded-xl border border-dashed border-emerald-600 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="create-character-title" className="font-semibold">
          {onboarding && quote.free ? t("onboardingTitle") : t("title")}
        </h3>
        {onboarding && quote.free ? null : (
          <span
            data-testid="create-character-price"
            className="rounded-full bg-emerald-50 px-2 py-0.5 text-sm text-emerald-900"
          >
            {quote.free ? t("free") : t("price", { tokens: tokens.format(quote.priceTokens) })}
          </span>
        )}
      </div>
      {mine.card && mine.thumb ? (
        <figure className="flex items-center gap-3" data-testid="create-character-current">
          <img
            src={mine.thumb}
            onError={mine.onError}
            alt={t("current")}
            width={64}
            height={64}
            decoding="async"
            className="h-16 w-16 rounded-full bg-emerald-50 object-cover object-top"
          />
          <figcaption className="grid text-sm">
            <span className="font-medium">{t("current")}</span>
            <span className="text-neutral-600">{t("currentNote")}</span>
          </figcaption>
        </figure>
      ) : null}
      <p className="text-sm text-neutral-700">{t("intro")}</p>

      {!onboarding && kept.length > 0 ? (
        <section aria-labelledby="kept-characters-title" className="grid gap-2" data-testid="kept-characters">
          <h4 id="kept-characters-title" className="text-sm font-medium">
            {t("kept.title")}
          </h4>
          <ul className="grid gap-2">
            {kept.map((k) => {
              const date = dates.format(new Date(k.createdAt));
              return (
                <li key={k.creationId} className="grid gap-2 rounded-lg bg-neutral-50 p-2" data-testid="kept-character">
                  <div className="flex flex-wrap items-center gap-3">
                    {k.thumb ? (
                      <img
                        src={k.thumb}
                        alt={t("kept.thumbAlt", { date })}
                        width={48}
                        height={48}
                        decoding="async"
                        className="h-12 w-12 rounded-full bg-emerald-50 object-cover object-top"
                      />
                    ) : null}
                    <span className="text-sm text-neutral-700">{t("kept.created", { date })}</span>
                    {k.worn ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-900">
                        {t("kept.worn")}
                      </span>
                    ) : null}
                    {confirming !== k.creationId ? (
                      <button
                        type="button"
                        className="ml-auto text-sm text-red-800 underline disabled:opacity-50"
                        disabled={busy}
                        data-testid="kept-character-delete"
                        onClick={() => {
                          setDeleteNote(null);
                          setConfirming(k.creationId);
                        }}
                      >
                        {t("delete.action")}
                      </button>
                    ) : null}
                  </div>
                  {confirming === k.creationId ? (
                    <div
                      ref={confirmRef}
                      tabIndex={-1}
                      role="group"
                      aria-labelledby={`delete-${k.creationId}-title`}
                      aria-describedby={`delete-${k.creationId}-body`}
                      className="grid gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-950"
                      data-testid="kept-character-confirm"
                    >
                      <p id={`delete-${k.creationId}-title`} className="font-medium">
                        {t("delete.confirmTitle")}
                      </p>
                      <p id={`delete-${k.creationId}-body`}>
                        {t("delete.confirmBody")} {k.worn ? t("delete.confirmWorn") : null}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-lg bg-red-700 px-3 py-1.5 text-white disabled:opacity-50"
                          disabled={busy}
                          data-testid="kept-character-confirm-yes"
                          onClick={() => void remove(k.creationId)}
                        >
                          {t("delete.confirm")}
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border px-3 py-1.5 disabled:opacity-50"
                          disabled={busy}
                          data-testid="kept-character-confirm-no"
                          onClick={() => setConfirming(null)}
                        >
                          {t("delete.cancel")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {deleteNote ? (
        <p
          role={deleteNote === "done" ? "status" : "alert"}
          data-testid="kept-character-note"
          className={`text-sm ${deleteNote === "done" ? "text-emerald-800" : "text-red-800"}`}
        >
          {t(`delete.${deleteNote}`)}
        </p>
      ) : null}

      {phase.kind === "idle" || phase.kind === "failed" ? (
        <>
          <p className="text-xs text-neutral-600">{t("privacy")}</p>
          {phase.kind === "failed" ? (
            <p
              role="alert"
              className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
              data-testid="create-character-failed"
            >
              {t(`failure.${phase.failure}`)} {t("notCharged")}
            </p>
          ) : null}
          <fieldset className="grid gap-2 rounded-lg bg-neutral-50 p-3 text-sm" data-testid="create-character-consent">
            <legend className="font-medium">{t("consent.title")}</legend>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={attest.ownPhoto}
                data-testid="create-character-own-photo"
                onChange={(e) => setAttest({ ...attest, ownPhoto: e.currentTarget.checked })}
              />
              <span>{t("consent.ownPhoto")}</span>
            </label>
            <p className="font-medium">{t("consent.age")}</p>
            {AGE_BANDS.map((b) => (
              <label key={b} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="create-character-age"
                  value={b}
                  checked={attest.ageBand === b}
                  data-testid={`create-character-age-${b}`}
                  onChange={() => setAttest({ ...attest, ageBand: b, guardianConsent: false })}
                />
                <span>{t(`consent.band.${b}`)}</span>
              </label>
            ))}
            {attest.ageBand === "13_17" ? (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={attest.guardianConsent}
                  data-testid="create-character-guardian"
                  onChange={(e) => setAttest({ ...attest, guardianConsent: e.currentTarget.checked })}
                />
                <span>{t("consent.guardian")}</span>
              </label>
            ) : null}
            {under13 ? (
              <p role="alert" className="text-amber-900" data-testid="create-character-under13">
                {t("consent.under13")}
              </p>
            ) : null}
          </fieldset>
          <label className="w-fit cursor-pointer rounded-lg border px-3 py-1.5 text-sm">
            {t("choose")}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              data-testid="create-character-file"
              onChange={(e) => pick(e.currentTarget.files?.[0] ?? null)}
            />
          </label>
          {preview ? (
            <img
              src={preview}
              alt={t("previewAlt")}
              className="h-40 w-40 rounded-lg object-cover"
              data-testid="create-character-preview"
            />
          ) : null}
          <button
            className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={!photo || busy || !attestationOk(attest)}
            data-testid="create-character-go"
            onClick={() => void create()}
          >
            {t("create")}
          </button>
        </>
      ) : null}

      {phase.kind === "uploading" || phase.kind === "working" ? (
        <p aria-live="polite" data-testid="create-character-status" className="flex items-center gap-2 text-sm">
          <span aria-hidden className="inline-block h-3 w-3 animate-pulse rounded-full bg-emerald-600" />
          {phase.kind === "uploading"
            ? t("status.uploading")
            : t(
                `status.${phase.creation.status === "queued" || phase.creation.status === "awaiting_upload" ? "queued" : "generating"}`,
              )}
        </p>
      ) : null}
      {onboarding && phase.kind === "working" ? (
        <p className="text-sm text-neutral-700" data-testid="create-character-carry-on">
          {t("onboardingWorking")}
        </p>
      ) : null}

      {phase.kind === "done" && card ? (
        <div className="grid gap-3" data-testid="create-character-result">
          <p aria-live="polite">{t("status.succeeded")}</p>
          <ul className="grid grid-cols-5 gap-2">
            {EMOTIONS.filter((e) => card.emotions[e]).map((e) => (
              <li key={e} className="grid justify-items-center gap-1 text-center">
                <img
                  src={card.urls[card.emotions[e]!]}
                  alt={t(`emotion.${e}`)}
                  className="aspect-[3/4] w-full object-contain"
                  decoding="async"
                />
                <span className="text-xs text-neutral-600">{t(`emotion.${e}`)}</span>
              </li>
            ))}
          </ul>
          {phase.used ? (
            <p data-testid="create-character-used" className="text-sm text-emerald-800">
              {t("inUse")}
            </p>
          ) : (
            <button
              className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
              disabled={busy}
              data-testid="create-character-use"
              onClick={() => void use(phase.creation)}
            >
              {t("use")}
            </button>
          )}
          <button className="w-fit text-sm text-emerald-700 underline" onClick={() => setPhase({ kind: "idle" })}>
            {t("again")}
          </button>
        </div>
      ) : null}

      {note ? (
        <p role="alert" data-testid="create-character-note" className="text-sm text-red-800">
          {t(note.kind)}{" "}
          {note.kind === "noTokens" ? (
            !note.chipHref || note.chipHref === "/creditos" ? (
              <Link href="/creditos" className="text-emerald-700 underline">
                {t("whyChip")}
              </Link>
            ) : (
              <a href={note.chipHref} className="text-emerald-700 underline">
                {t("whyChip")}
              </a>
            )
          ) : null}
        </p>
      ) : null}
    </section>
  );
};
