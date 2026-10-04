import { getTranslations } from "next-intl/server";
import { legalDocument } from "@/lib/legal";
import type { LegalDoc } from "@/lib/legal-text";
import { Markdown } from "./Markdown";

/** /privacidad and /terminos: rendered from packages/config/legal, with a draft banner until reviewed. */
export const LegalPage = async ({ doc, locale }: { doc: LegalDoc; locale: "es" | "en" }) => {
  const t = await getTranslations("legal");
  const { markdown, reviewed } = legalDocument(doc, locale);
  return (
    <article className="grid gap-4" data-testid={`legal-${doc}`} data-reviewed={reviewed}>
      {reviewed ? null : (
        <div
          role="note"
          data-testid="legal-draft"
          className="rounded-xl border-2 border-amber-500 bg-amber-50 p-4 text-amber-950"
        >
          <p className="text-lg font-bold">{t("draftTitle")}</p>
          <p className="text-sm">{t("draftBody")}</p>
        </div>
      )}
      <Markdown source={markdown} />
    </article>
  );
};
