import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

/** Site footer: the legal pages, on every page. */
export const Footer = async () => {
  const t = await getTranslations("legal");
  return (
    <footer className="mx-auto flex max-w-3xl flex-wrap gap-x-4 gap-y-1 px-4 pb-8 text-sm text-neutral-600">
      <Link href="/privacidad" className="underline">
        {t("privacy")}
      </Link>
      <Link href="/terminos" className="underline">
        {t("terms")}
      </Link>
    </footer>
  );
};
