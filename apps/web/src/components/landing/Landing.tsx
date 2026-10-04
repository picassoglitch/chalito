import { getLocale, getTranslations } from "next-intl/server";
import { CREDIT_SUFFIX, PRODUCT_NAME } from "@chalito/brand";
import { ROSTER } from "@chalito/roster";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { plansForLanding } from "@/lib/plans";
import { showcase } from "@/lib/showcase";
import { LandingCta } from "./LandingCta";
import { Plans } from "./Plans";
import { Render } from "./Render";

// Module scope on purpose: an id missing from the manifest fails the build (see lib/showcase).
const HERO = showcase("hero-chalito");
const ROSTER_CARDS = ROSTER.map((r) => ({ name: r.name, asset: showcase(`roster-${r.id}`) }));
const TRYON = [showcase("tryon-chalito-viking"), showcase("tryon-luna-crown"), showcase("tryon-bruno-cape")];
const RECHARGE = showcase("recharge-chalito");
const ROOM = showcase("room-portal");

/** The public page at / and /en: real renders of the runtime, the plans from plans.yaml, no claims beyond the product. */
export const Landing = async () => {
  const locale = (await getLocale()) as AppLocale;
  const t = await getTranslations("landing");
  const th = await getTranslations("home");
  const plans = plansForLanding();
  return (
    <div className="grid gap-16 pb-8">
      <section className="grid items-center gap-6 sm:grid-cols-2">
        <div className="grid gap-4">
          <h1 className="text-3xl font-bold">{th("title", { name: PRODUCT_NAME })}</h1>
          <p className="text-sm text-neutral-600" data-testid="landing-credit">
            {CREDIT_SUFFIX[locale]}
          </p>
          <p className="text-lg">{th("subtitle")}</p>
          <div className="flex flex-wrap gap-3">
            <LandingCta />
            <Link href="/descargar" className="w-fit rounded-lg border px-4 py-2">
              {t("download")}
            </Link>
          </div>
        </div>
        <Render asset={HERO} locale={locale} eager className="mx-auto max-w-xs" />
      </section>

      <section className="grid gap-4" aria-labelledby="landing-roster">
        <h2 id="landing-roster" className="text-2xl font-semibold">
          {t("roster.title")}
        </h2>
        <p>{t("roster.body")}</p>
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {ROSTER_CARDS.map((c) => (
            <li key={c.asset.id} className="grid gap-1 text-center">
              <Render asset={c.asset} locale={locale} />
              <span className="font-medium">{c.name[locale]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-4" aria-labelledby="landing-tryon">
        <h2 id="landing-tryon" className="text-2xl font-semibold">
          {t("tryon.title")}
        </h2>
        <p>{t("tryon.body")}</p>
        <div className="grid grid-cols-3 gap-4">
          {TRYON.map((a) => (
            <Render key={a.id} asset={a} locale={locale} />
          ))}
        </div>
      </section>

      <section className="grid items-center gap-6 sm:grid-cols-2" aria-labelledby="landing-together">
        <Render asset={ROOM} locale={locale} />
        <div className="grid gap-3">
          <h2 id="landing-together" className="text-2xl font-semibold">
            {t("together.title")}
          </h2>
          <p>{t("together.body")}</p>
        </div>
      </section>

      <section className="grid items-center gap-6 sm:grid-cols-2" aria-labelledby="landing-recharge">
        <div className="grid gap-3">
          <h2 id="landing-recharge" className="text-2xl font-semibold">
            {t("recharge.title")}
          </h2>
          <p>{t("recharge.body")}</p>
        </div>
        <Render asset={RECHARGE} locale={locale} className="mx-auto max-w-xs" />
      </section>

      <Plans plans={plans} locale={locale} />

      <footer className="border-t pt-4 text-sm text-neutral-600">
        {PRODUCT_NAME} · {CREDIT_SUFFIX[locale]}
      </footer>
    </div>
  );
};
