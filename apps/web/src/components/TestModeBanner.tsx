"use client";
import { useTranslations } from "next-intl";
import { DEV_BACKEND } from "@/lib/env";

/** Visible whenever the dev/test mock backend is on, so a test build can never pass for the real app. */
export const TestModeBanner = () => {
  const t = useTranslations("live");
  if (!DEV_BACKEND) return null;
  return (
    <div data-testid="test-mode" className="bg-neutral-900 px-4 py-1 text-center text-xs text-white">
      {t("testMode")}
    </div>
  );
};
