import { getTranslations, setRequestLocale } from "next-intl/server";

export default async function DownloadPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  const t = await getTranslations("download");
  return (
    <div className="grid gap-2">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p>{t("body")}</p>
    </div>
  );
}
