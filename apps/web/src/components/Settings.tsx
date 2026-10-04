"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsPanel, type SettingsValues } from "@chalito/ui";
import { env } from "@/lib/env";
import { loadSettings, saveSettings } from "@/lib/local";

export const Settings = () => {
  const t = useTranslations("settings");
  const ti = useTranslations("integrations");
  const [values, setValues] = useState<SettingsValues | null>(null);
  useEffect(() => setValues(loadSettings()), []);
  if (!values) return null;
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <SettingsPanel
        shell="web"
        values={values}
        onChange={(k, v) => {
          const next = { ...values, [k]: v };
          setValues(next);
          saveSettings(next);
        }}
        providerLabel={(p) => ti(`${p}.name`)}
        hubPlansUrl={env.hubUrl || "#"}
      />
    </div>
  );
};
