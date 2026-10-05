"use client";
import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import type { Balance } from "@/lib/balance";
import { env } from "@/lib/env";
import { Link } from "@/i18n/navigation";
import { useChalito } from "./ChalitoProvider";

/** The Chalyb tiers this page can name (packages/config plans.yaml hubTiers). */
const HUB_TIERS = new Set(["free", "pro", "vip"]);

/** Where credits are bought: the hub's usage page (token packs). Prices only ever live there. */
export const rechargeUrl = (hubUrl: string): string | null => (hubUrl ? `${hubUrl}/app/usage` : null);

/**
 * /creditos: where the store's "no tokens" chip and budget notifications land. The plan, the hub
 * balance in tokens (/v1/billing/balance), how Chalito spends tokens, and the way to recharge on
 * Chalyb. Tokens only: no prices or currency here.
 */
const BalanceCard = () => {
  const t = useTranslations("credits.balance");
  const format = useFormatter();
  const { balance } = useChalito();
  const [b, setB] = useState<Balance | "loading" | "unavailable" | "error">("loading");
  useEffect(() => {
    if (!balance) return;
    let alive = true;
    void balance().then((r) => alive && setB(r));
    return () => {
      alive = false;
    };
  }, [balance]);
  if (!balance) return null;
  const n = (v: number) => format.number(v);
  return (
    <section className="grid gap-2 rounded-xl border bg-white p-4" data-testid="credits-balance">
      <h2 className="font-semibold">{t("title")}</h2>
      {b === "loading" ? (
        <p aria-live="polite">{t("loading")}</p>
      ) : b === "unavailable" || b === "error" ? (
        <p role="alert" data-testid="balance-error">
          {t(b)}
        </p>
      ) : b.unlimited ? (
        <p data-testid="balance-remaining" className="text-xl font-semibold">
          {t("unlimited")}
        </p>
      ) : (
        <>
          <p data-testid="balance-remaining" className="text-xl font-semibold">
            {t("remaining", { tokens: n(b.remaining) })}
          </p>
          <dl className="grid grid-cols-2 gap-1 text-sm">
            <dt className="text-neutral-600">{t("monthly")}</dt>
            <dd data-testid="balance-monthly">{t("tokens", { tokens: n(b.monthlyAllocation) })}</dd>
            {b.bonus > 0 ? (
              <>
                <dt className="text-neutral-600">{t("bonus")}</dt>
                <dd data-testid="balance-bonus">{t("tokens", { tokens: n(b.bonus) })}</dd>
              </>
            ) : null}
            <dt className="text-neutral-600">
              {t("used", { date: format.dateTime(b.periodStart, { dateStyle: "medium" }) })}
            </dt>
            <dd data-testid="balance-used">{t("tokens", { tokens: n(b.monthlyUsed) })}</dd>
            {b.reserved > 0 ? (
              <>
                <dt className="text-neutral-600">{t("reserved")}</dt>
                <dd data-testid="balance-reserved">{t("tokens", { tokens: n(b.reserved) })}</dd>
              </>
            ) : null}
          </dl>
        </>
      )}
    </section>
  );
};

export const Credits = () => {
  const t = useTranslations("credits");
  const tp = useTranslations("landing.plans.hub");
  const { settings, status } = useChalito();
  const [tier, setTier] = useState<string | null | "loading">("loading");

  useEffect(() => {
    if (status === "loading") return;
    if (!settings) return setTier(null);
    let alive = true;
    void settings
      .load()
      .then((r) => alive && setTier(r.values.planCredits.tier))
      .catch(() => alive && setTier(null));
    return () => {
      alive = false;
    };
  }, [settings, status]);

  const recharge = rechargeUrl(env.hubUrl);
  return (
    <div className="grid max-w-2xl gap-5">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <section className="grid gap-2 rounded-xl border bg-white p-4" data-testid="credits-plan">
        <h2 className="font-semibold">{t("plan.title")}</h2>
        {tier === "loading" ? (
          <p aria-live="polite">{t("plan.loading")}</p>
        ) : tier && HUB_TIERS.has(tier) ? (
          <p data-testid="credits-tier">{t("plan.yours", { plan: tp(tier) })}</p>
        ) : (
          <p data-testid="credits-tier">{status === "signed_out" ? t("plan.signedOut") : t("plan.unknown")}</p>
        )}
        <p className="text-sm text-neutral-600">{t("plan.fromHub")}</p>
      </section>
      <BalanceCard />
      <section className="grid gap-2" data-testid="credits-explain">
        <h2 className="font-semibold">{t("how.title")}</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t("how.tokens")}</li>
          <li>{t("how.byo")}</li>
          <li>{t("how.basics")}</li>
          <li>{t("how.recharge")}</li>
        </ul>
      </section>
      <div className="flex flex-wrap items-center gap-4">
        {recharge ? (
          <a
            href={recharge}
            rel="noopener"
            data-testid="credits-recharge"
            className="rounded-lg bg-emerald-700 px-4 py-2 text-white"
          >
            {t("recharge")}
          </a>
        ) : null}
        <Link href="/uso" className="text-emerald-700 underline">
          {t("usage")}
        </Link>
      </div>
    </div>
  );
};
