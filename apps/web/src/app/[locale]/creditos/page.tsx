import { getTranslations, setRequestLocale } from "next-intl/server";
import { Stub } from "@/components/Stub";

export default async function CreditsPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  const t = await getTranslations("deeplinks");
  return <Stub title={t("credits")} />;
}
