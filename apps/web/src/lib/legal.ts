import "server-only";
import liabilityEn from "@chalito/config/legal/devmode-liability.en.md";
import liabilityEs from "@chalito/config/legal/devmode-liability.es.md";
import status from "@chalito/config/legal/legal.yaml";
import privacyEn from "@chalito/config/legal/privacy.en.md";
import privacyEs from "@chalito/config/legal/privacy.es.md";
import termsEn from "@chalito/config/legal/terms.en.md";
import termsEs from "@chalito/config/legal/terms.es.md";
import { fillLegal, isReviewed, parseLiability, type LegalDoc } from "./legal-text";

const DOCS: Record<LegalDoc, Record<"es" | "en", string>> = {
  privacy: { es: privacyEs, en: privacyEn },
  terms: { es: termsEs, en: termsEn },
};
const LIABILITY = { es: liabilityEs, en: liabilityEn };

export const legalDocument = (doc: LegalDoc, locale: "es" | "en"): { markdown: string; reviewed: boolean } => ({
  markdown: fillLegal(DOCS[doc][locale], parseLiability(LIABILITY[locale])),
  reviewed: isReviewed(status),
});
