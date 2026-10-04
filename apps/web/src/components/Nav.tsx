"use client";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

export const Nav = () => {
  const t = useTranslations("nav");
  const tc = useTranslations("common");
  const locale = useLocale();
  const pathname = usePathname();
  const params = useParams<{ id?: string; sid?: string }>();
  const other = locale === "es" ? "en" : "es";
  return (
    <nav className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
      <Link href="/" className="font-semibold">
        {tc("appName")}
      </Link>
      <Link href="/bandeja">{t("inbox")}</Link>
      <Link href="/sesiones">{t("sessions")}</Link>
      <Link href="/dispositivos">{t("devices")}</Link>
      <Link href="/ajustes">{t("settings")}</Link>
      <Link
        // Same page, other locale: "/" ⇄ "/en", "/a/x" ⇄ "/en/a/x".
        href={
          (params.id || params.sid ? { pathname, params: { id: params.id, sid: params.sid } } : { pathname }) as never
        }
        locale={other}
        className="ml-auto rounded border px-2 py-1"
        data-testid="locale-switch"
      >
        {other.toUpperCase()}
      </Link>
    </nav>
  );
};
