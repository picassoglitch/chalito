"use client";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useLive } from "./ChalitoProvider";

/** "Modo desarrollador ACTIVO" on every screen while any of the owner's devices has it on. */
export const DevModeBanner = () => {
  const t = useTranslations("live.devMode");
  const { devModeActive } = useLive();
  if (!devModeActive) return null;
  return (
    <div
      role="status"
      data-testid="devmode-banner"
      className="bg-red-700 px-4 py-2 text-center text-sm font-semibold text-white"
    >
      {t("banner")}{" "}
      <Link href="/dispositivos" className="underline">
        {t("manage")}
      </Link>
    </div>
  );
};
