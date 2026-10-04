import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Stub } from "@/components/Stub";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export default async function Page({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!ID.test(id)) notFound();
  const t = await getTranslations("deeplinks");
  return <Stub title={t("approval", { id })} />;
}
