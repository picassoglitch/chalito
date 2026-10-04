"use client";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

export const Nav = () => {
  const t = useTranslations("nav");
  const tc = useTranslations("common");
  const locale = useLocale();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const other = locale === "es" ? "en" : "es";
  return (
    <nav className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3 text-sm">
      <Link href="/" className="font-semibold">
        {tc("appName")}
      </Link>
      <Link href="/bienvenida">{t("onboarding")}</Link>
      <Link href="/ajustes">{t("settings")}</Link>
      <Link href="/creditos">{t("credits")}</Link>
      <Link
        // Same page, other locale: "/" ⇄ "/en", "/a/x" ⇄ "/en/a/x".
        href={(params.id ? { pathname, params: { id: params.id } } : { pathname }) as never}
        locale={other}
        className="ml-auto rounded border px-2 py-1"
        data-testid="locale-switch"
      >
        {other.toUpperCase()}
      </Link>
    </nav>
  );
};
