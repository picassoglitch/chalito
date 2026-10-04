import { setRequestLocale } from "next-intl/server";
import { Store } from "@/components/Store";

export default async function StorePage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return <Store />;
}
