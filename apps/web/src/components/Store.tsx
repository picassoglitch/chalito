"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { placeOnCard, rosterEntry, type CardAnchor } from "@chalito/roster";
import { companionName } from "@chalito/ui";
import { Link } from "@/i18n/navigation";
import { hubLaunchUrl } from "@/lib/hub";
import { signInAndReturn } from "@/lib/next-cookie";
import { newPurchaseId, type CompanionLook, type Slot, type StoreItem } from "@/lib/store";
import { useChalito } from "./ChalitoProvider";

const ROSTER = "/roster";
const asset = (path: string) => `${ROSTER}/${path}`;

interface Card {
  width: number;
  height: number;
  anchors: Partial<Record<Slot, CardAnchor>>;
}

type Note =
  | { kind: "no_tokens"; chipHref: string }
  | { kind: "retry" }
  | { kind: "failed" }
  | { kind: "equip_failed"; reason: string };

/** The companion's card with what it wears, placed by `placeOnCard` (negative z sits behind the body). */
const Preview = ({ look, items, label }: { look: CompanionLook; items: StoreItem[]; label: string }) => {
  const [card, setCard] = useState<Card | null>(null);
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const entry = rosterEntry(look.avatar);
  useEffect(() => {
    if (!entry) return;
    let alive = true;
    void fetch(asset(entry.card))
      .then((r) => (r.ok ? (r.json() as Promise<Card>) : null))
      .then((c) => alive && setCard(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [entry]);
  if (!entry) return null;
  const worn = items.filter((i) => look.equipped[i.slot] === i.id);
  if (!card) return <div aria-hidden className="mx-auto mt-12 aspect-[3/4] w-48 sm:w-56" />;
  const cardAspect = card.height / card.width;
  return (
    // Headroom above the card: hats and auras reach past its top edge.
    <figure
      className="relative mx-auto mt-12 w-48 sm:w-56"
      style={{ aspectRatio: `${card.width} / ${card.height}` }}
      role="img"
      aria-label={label}
      data-testid="store-preview"
      data-worn={worn.map((i) => i.id).join(" ")}
    >
      <img
        src={asset(entry.drawings.neutral)}
        alt=""
        className="absolute inset-0 h-full w-full object-contain"
        style={{ zIndex: 0 }}
        decoding="async"
      />
      {worn.map((i) => {
        const anchor = card.anchors[i.slot];
        const aspect = aspects[i.id];
        const p = anchor && aspect ? placeOnCard(anchor, i.card, aspect, cardAspect) : null;
        return (
          <img
            key={i.id}
            src={asset(i.art)}
            alt=""
            data-testid="store-worn"
            data-item={i.id}
            decoding="async"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth > 0) setAspects((a) => ({ ...a, [i.id]: img.naturalHeight / img.naturalWidth }));
            }}
            className="absolute"
            style={
              p
                ? {
                    left: `${p.left * 100}%`,
                    top: `${p.top * 100}%`,
                    width: `${p.width * 100}%`,
                    height: `${p.height * 100}%`,
                    zIndex: p.z,
                  }
                : { visibility: "hidden", width: "10%" }
            }
          />
        );
      })}
    </figure>
  );
};

/**
 * /tienda: cosmetics for the companion. They change how it looks, never what it can do. Prices
 * are hub tokens (never money). A buy tap makes one purchaseId and reuses it on retry, so a retry
 * never charges twice; not enough tokens shows an inline chip to /creditos, never a modal.
 */
export const Store = () => {
  const t = useTranslations("store");
  const locale = useLocale() as "es" | "en";
  const { status, store, readCompanion } = useChalito();
  const [items, setItems] = useState<StoreItem[] | "error" | null>(null);
  const [look, setLook] = useState<CompanionLook | null | "error" | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  /** cosmeticId → the purchaseId of the tap in progress (kept until the purchase settles). */
  const pending = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!store || !readCompanion) return;
    const [c, l] = await Promise.all([store.catalog(), readCompanion()]);
    setItems(c);
    setLook(l);
  }, [store, readCompanion]);
  useEffect(() => void load(), [load]);

  const note = (id: string, n: Note | null) =>
    setNotes((all) => {
      const next = { ...all };
      if (n) next[id] = n;
      else delete next[id];
      return next;
    });

  const buy = async (item: StoreItem, retry = false) => {
    if (!store) return;
    if (!retry || !pending.current[item.id]) pending.current[item.id] = newPurchaseId();
    setBusy(item.id);
    note(item.id, null);
    const r = await store.purchase(item.id, pending.current[item.id]!);
    setBusy(null);
    if (r.ok) {
      delete pending.current[item.id];
      setItems((all) => (Array.isArray(all) ? all.map((i) => (i.id === item.id ? { ...i, owned: true } : i)) : all));
      return;
    }
    if (r.reason === "retry") return note(item.id, { kind: "retry" });
    delete pending.current[item.id];
    note(item.id, r.reason === "no_tokens" ? { kind: "no_tokens", chipHref: r.chipHref } : { kind: "failed" });
  };

  const equip = async (item: StoreItem, on: boolean) => {
    if (!store || !look || look === "error") return;
    setBusy(item.id);
    note(item.id, null);
    const r = await store.equip(look.companionId, item.slot, on ? item.id : null);
    setBusy(null);
    if (!r.ok) return note(item.id, { kind: "equip_failed", reason: r.reason });
    setLook((l) => {
      if (!l || l === "error") return l;
      const equipped = { ...l.equipped };
      if (on) equipped[item.slot] = item.id;
      else delete equipped[item.slot];
      return { ...l, equipped };
    });
  };

  if (status === "loading") return <p aria-live="polite">{t("loading")}</p>;
  if (status === "signed_out" || !store)
    return (
      <div className="grid gap-3" data-testid="store-signin">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p>{t("signIn")}</p>
        {hubLaunchUrl() ? (
          <a
            className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white"
            href={hubLaunchUrl()!}
            onClick={(e) => {
              e.preventDefault();
              signInAndReturn(window.location.pathname);
            }}
          >
            {t("signInCta")}
          </a>
        ) : null}
      </div>
    );

  const tokens = new Intl.NumberFormat(locale);
  return (
    <div className="grid gap-6" data-testid="store">
      <div className="grid gap-1">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-neutral-600">{t("intro")}</p>
      </div>

      {look && look !== "error" ? (
        <Preview
          look={look}
          items={Array.isArray(items) ? items : []}
          label={t("previewLabel", { name: companionName(look.avatar, locale) })}
        />
      ) : look === null ? (
        <p data-testid="store-no-companion" className="rounded-lg border p-4">
          {t("noCompanion")}{" "}
          <Link href="/bienvenida" className="text-emerald-700 underline">
            {t("chooseCompanion")}
          </Link>
        </p>
      ) : null}

      {items === null ? <p aria-live="polite">{t("loading")}</p> : null}
      {items === "error" ? (
        <div role="alert" data-testid="store-error" className="grid gap-2 rounded-lg bg-red-50 p-4 text-red-900">
          <p>{t("error")}</p>
          <button className="w-fit rounded-lg border border-red-800 px-3 py-1" onClick={() => void load()}>
            {t("retry")}
          </button>
        </div>
      ) : null}

      {Array.isArray(items) ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((item) => {
            const worn = !!look && look !== "error" && look.equipped[item.slot] === item.id;
            const n = notes[item.id];
            return (
              <li
                key={item.id}
                data-testid="store-item"
                data-item={item.id}
                data-owned={item.owned}
                data-worn={worn}
                className="grid content-start gap-2 rounded-xl border bg-white p-3"
              >
                <img
                  src={asset(item.art)}
                  alt=""
                  width={160}
                  height={160}
                  loading="lazy"
                  decoding="async"
                  className="aspect-square w-full rounded-lg bg-neutral-50 object-contain"
                />
                <p className="font-medium">{item.name[locale]}</p>
                <p className="text-xs text-neutral-600">{t(`slot.${item.slot}`)}</p>
                <p className="text-sm" data-testid="store-price">
                  {item.free
                    ? t("free")
                    : item.owned
                      ? t("owned")
                      : t("price", { tokens: tokens.format(item.priceTokens!) })}
                </p>
                {!item.owned ? (
                  <button
                    data-testid="store-buy"
                    className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => void buy(item)}
                  >
                    {t("buy")}
                  </button>
                ) : look && look !== "error" ? (
                  <button
                    data-testid={worn ? "store-unequip" : "store-equip"}
                    className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
                    disabled={busy !== null}
                    aria-pressed={worn}
                    onClick={() => void equip(item, !worn)}
                  >
                    {worn ? t("unequip") : t("equip")}
                  </button>
                ) : null}
                {n?.kind === "no_tokens" ? (
                  <p role="status" data-testid="store-no-tokens" className="text-sm">
                    {t("noTokens")}{" "}
                    {n.chipHref === "/creditos" ? (
                      <Link
                        href="/creditos"
                        className="inline-block rounded-full border px-2 py-0.5 text-xs text-emerald-800"
                      >
                        {t("whyChip")}
                      </Link>
                    ) : (
                      <a
                        href={n.chipHref}
                        className="inline-block rounded-full border px-2 py-0.5 text-xs text-emerald-800"
                      >
                        {t("whyChip")}
                      </a>
                    )}
                  </p>
                ) : null}
                {n?.kind === "retry" ? (
                  <p role="alert" data-testid="store-retry" className="grid gap-1 text-sm text-red-800">
                    {t("retryBuy")}
                    <button
                      className="w-fit rounded border border-red-800 px-2 py-0.5"
                      disabled={busy !== null}
                      onClick={() => void buy(item, true)}
                    >
                      {t("retry")}
                    </button>
                  </p>
                ) : null}
                {n?.kind === "failed" ? (
                  <p role="alert" className="text-sm text-red-800">
                    {t("failed")}
                  </p>
                ) : null}
                {n?.kind === "equip_failed" ? (
                  <p role="alert" data-testid="store-equip-error" className="text-sm text-red-800">
                    {t(`equipError.${n.reason}`)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="text-xs text-neutral-500">{t("lookOnly")}</p>
    </div>
  );
};
