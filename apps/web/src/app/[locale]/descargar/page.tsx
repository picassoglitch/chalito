import { setRequestLocale } from "next-intl/server";
import { Download } from "@/components/Download";

export default async function DownloadPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return <Download />;
}
