import { setRequestLocale } from "next-intl/server";
import { Home } from "@/components/Home";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return <Home />;
}
