import { useT } from "../../lib/i18n.js";

/** Placeholder until the marketplace search lands (its own PR replaces this file). */
export const SearchSection = () => {
  const t = useT();
  return (
    <section className="card" aria-labelledby="connections-search-title" data-connections-search>
      <h2 id="connections-search-title">{t("connections.search.title")}</h2>
      <p className="muted">{t("connections.search.soon")}</p>
    </section>
  );
};
