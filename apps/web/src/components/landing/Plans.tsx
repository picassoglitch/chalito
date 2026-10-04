import { getTranslations } from "next-intl/server";
import type { AppLocale } from "@/i18n/routing";
import type { LandingPlans } from "@/lib/landing-plans";

const mxn = (amount: number, locale: AppLocale) =>
  new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
    style: "currency",
    currency: "MXN",
    maximumFractionDigits: 0,
  }).format(amount);

/** Plans from plans.yaml: the Solo ladder (MXN amounts set on the hub, else "coming soon") and the Chalyb tiers. */
export const Plans = async ({ plans, locale }: { plans: LandingPlans; locale: AppLocale }) => {
  const t = await getTranslations("landing.plans");
  return (
    <section className="grid gap-6" aria-labelledby="landing-plans" data-testid="landing-plans">
      <h2 id="landing-plans" className="text-2xl font-semibold">
        {t("title")}
      </h2>
      <div className="grid gap-3">
        <h3 className="text-lg font-semibold">{t("solo.title")}</h3>
        <p>{t("solo.body")}</p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {plans.solo.map((p) => (
            <li key={p.id} className="grid gap-1 rounded-lg border p-4" data-testid={`plan-${p.id}`}>
              <span className="font-semibold">{p.name}</span>
              <span data-testid={`plan-${p.id}-price`}>
                {p.mxn === null ? t("soon") : t("perMonth", { price: mxn(p.mxn, locale) })}
              </span>
              <ul className="text-sm text-neutral-600">
                {p.devices !== null ? <li>{t("devices", { n: p.devices })}</li> : null}
                {p.sessions !== null ? <li>{t("sessions", { n: p.sessions })}</li> : null}
                {p.voiceMinutes ? <li>{t("voiceMinutes", { n: p.voiceMinutes })}</li> : null}
                {p.rooms !== null ? <li>{t("rooms", { n: p.rooms })}</li> : null}
              </ul>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-3">
        <h3 className="text-lg font-semibold">{t("hub.title")}</h3>
        <p>{t("hub.body")}</p>
        <ul className="grid gap-3 sm:grid-cols-3">
          {plans.hub.map((h) => (
            <li key={h.id} className="grid gap-1 rounded-lg border p-4" data-testid={`hub-${h.id}`}>
              <span className="font-semibold">{t(`hub.${h.id}`)}</span>
              <span className="text-sm text-neutral-600">
                {h.includes ? t("hub.includes", { tier: h.includes }) : t("hub.byo")}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};
