import { useT } from "../lib/i18n.js";

export const CREDITS_URL = "https://github.com/picassoglitch/chalito/blob/main/CREDITS.md";

/** Settings → Créditos: Omar let Chalito use ideas and code from his companion Alux (owner, 2026-10-25). */
export const Credits = ({ openUrl }: { openUrl?: (url: string) => Promise<void> }) => {
  const t = useT();
  return (
    <section aria-labelledby="credits-title" data-credits className="card">
      <h2 id="credits-title">{t("credits.title")}</h2>
      <p>{t("credits.line")}</p>
      <a
        href={CREDITS_URL}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          if (!openUrl) return;
          e.preventDefault();
          void openUrl(CREDITS_URL).catch(() => undefined);
        }}
      >
        {t("credits.link")}
      </a>
    </section>
  );
};
