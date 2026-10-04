"use client";
import { useTranslations } from "next-intl";
import { APP_HOME } from "@chalito/ui";
import { Link } from "@/i18n/navigation";
import { useSession } from "@/lib/session";
import { SignInLink } from "../SignInLink";

/** Signed in: a way into the app (no redirect, so / stays the same page for everyone). Signed out: sign in. */
export const LandingCta = () => {
  const t = useTranslations("landing");
  const session = useSession();
  if (session.status === "signed_in")
    return (
      <Link
        href="/bandeja"
        data-testid="landing-inbox"
        className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white"
      >
        {t("toInbox")}
      </Link>
    );
  if (session.status === "signed_out") return <SignInLink returnTo={APP_HOME}>{t("signIn")}</SignInLink>;
  return null;
};
