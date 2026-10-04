"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { env } from "@/lib/env";
import { Link } from "@/i18n/navigation";
import { useChalito } from "./ChalitoProvider";

/** The Chalyb tiers this page can name (packages/config plans.yaml hubTiers). */
const HUB_TIERS = new Set(["free", "pro", "vip"]);

/** Where credits are bought: the hub's usage page (token packs). Prices only ever live there. */
export const rechargeUrl = (hubUrl: string): string | null => (hubUrl ? `${hubUrl}/app/usage` : null);

/**
 * /creditos: where the store's "no tokens" chip and budget notifications land. The balance lives
 * in the Chalyb hub and the web has no endpoint for it, so this shows the plan, how Chalito spends
 * tokens, and the way to recharge on Chalyb. No amounts or currency here.
 */
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
