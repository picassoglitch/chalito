"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  CompanionNameField,
  CompanionPicker,
  DEFAULT_COMPANION,
  SETTINGS,
  type SettingContext,
  type SettingsValues,
} from "@chalito/ui";
import { Link, useRouter } from "@/i18n/navigation";
import { env } from "@/lib/env";
import { loadSettings, markOnboarded, saveSettings } from "@/lib/local";
import { sessionTier, useSession } from "@/lib/session";

/** One entry per coding agent in providers.yaml, with its official auth paths. */
export interface AgentOption {
  agent: "claude-code" | "codex" | "grok-build";
  provider: "anthropic" | "openai" | "xai";
  auth: string[];
  /** providers.yaml `subscriptionLocal` for the provider (off | owner_only | on | approved). */
  subscription: string;
}

const STEPS = ["signIn", "companion", "name", "connect", "billing", "phone", "pair"] as const;
type Step = (typeof STEPS)[number];
type BillingMode = "byo" | "energy" | "both";

export const Onboarding = ({ agents }: { agents: AgentOption[] }) => {
  const t = useTranslations("onboarding");
  const tc = useTranslations("common");
  const ti = useTranslations("integrations");
  const router = useRouter();
  const session = useSession();
  const [i, setI] = useState(0);
  const [values, setValues] = useState<SettingsValues | null>(null);
  const [billing, setBilling] = useState<BillingMode>("byo");
  const [path, setPath] = useState<"guided" | "expert">("guided");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setValues(loadSettings()), []);
  if (!values) return <p>{tc("loading")}</p>;

  const step: Step = STEPS[i]!;
  const set: SettingContext["set"] = (k, v) => setValues((cur) => (cur ? { ...cur, [k]: v } : cur));
  const next = () => {
    saveSettings(values);
    if (i < STEPS.length - 1) setI(i + 1);
    else {
      markOnboarded();
      router.push("/");
    }
  };
  const signedIn = session.status === "signed_in";
  const tier = session.status === "signed_in" ? sessionTier(session.session) : null;
  const ctx: SettingContext = {
    values,
    set,
    shell: "web",
    providerLabel: (p) => ti(`${p}.name`),
    hubPlansUrl: env.hubUrl || "#",
  };

  return (
    <div className="grid gap-6" data-step={step}>
      <p className="text-sm text-neutral-600">{t("progress", { step: i + 1, total: STEPS.length })}</p>
      <h1 className="text-2xl font-bold">{t(`${step}.title`)}</h1>

      {step === "signIn" ? (
        signedIn ? (
          <p data-testid="signed-in">{t("signIn.signedIn")}</p>
        ) : (
          <div className="grid gap-3">
            <p>{t("signIn.body")}</p>
            {env.hubUrl ? (
              <a className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white" href={env.hubUrl}>
                {t("signIn.cta")}
              </a>
            ) : null}
          </div>
        )
      ) : null}

      {step === "companion" ? (
        <div className="grid gap-3">
          <p>{t("companion.body")}</p>
          <CompanionPicker value={values.avatar} onChange={(c) => set("avatar", c)} />
        </div>
      ) : null}

      {step === "name" ? (
        <div className="grid gap-3">
          <p>{t("name.body")}</p>
          <CompanionNameField value={values.companionName} onChange={(v) => set("companionName", v)} />
        </div>
      ) : null}

      {step === "connect" ? (
        <div className="grid gap-4">
          <p>{t("connect.body")}</p>
          <div role="tablist" className="flex gap-2">
            {(["guided", "expert"] as const).map((p) => (
              <button
                key={p}
                role="tab"
                aria-selected={path === p}
                className={`rounded-lg border px-3 py-1 ${path === p ? "bg-neutral-900 text-white" : ""}`}
                onClick={() => setPath(p)}
              >
                {t(`connect.${p}`)}
              </button>
            ))}
          </div>
          {path === "guided" ? (
            <ul className="grid gap-2">
              {agents.map((a) => (
                <li key={a.agent} className="rounded-lg border p-3">
                  <button className="font-medium" aria-expanded={open === a.agent} onClick={() => setOpen(a.agent)}>
                    {ti("iHave", { name: ti(`${a.provider}.name`) })}
                  </button>
                  {open === a.agent ? (
                    <div className="mt-2 grid gap-1 text-sm">
                      <p data-testid={`howto-${a.agent}`}>{ti(`${a.provider}.howTo`)}</p>
                      {a.subscription === "owner_only" ? (
                        <p className="text-amber-800">{ti(`${a.provider}.ownerOnly`)}</p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("connect.expertBody")}</p>
          )}
          <p className="text-sm text-neutral-600">{t("connect.later")}</p>
        </div>
      ) : null}

      {step === "billing" ? (
        <div className="grid gap-3">
          <p>{t("billing.body")}</p>
          <p>{tier ? t("billing.tier", { tier }) : t("billing.tierUnknown")}</p>
          <fieldset className="grid gap-2">
            {(["byo", "energy", "both"] as const).map((m) => (
              <label key={m} className="flex items-start gap-2">
                <input type="radio" name="billing" checked={billing === m} onChange={() => setBilling(m)} />
                <span>{t(`billing.${m}`)}</span>
              </label>
            ))}
          </fieldset>
          {env.hubUrl ? (
            <a className="text-emerald-700 underline" href={env.hubUrl} rel="noopener">
              {t("billing.manage")}
            </a>
          ) : null}
        </div>
      ) : null}

      {step === "phone" ? (
        <div className="grid gap-4">
          <p>{t("phone.body")}</p>
          {/* The same registry entries as Ajustes, charges notice included. */}
          {SETTINGS.filter((s) => s.key === "phone" || s.key === "whatsapp" || s.key === "calls").map((s) => (
            <div key={s.key} data-setting-key={s.key}>
              {s.render(ctx)}
            </div>
          ))}
        </div>
      ) : null}

      {step === "pair" ? (
        <div className="grid gap-3">
          <p>{t("pair.body")}</p>
          <Link href="/descargar" className="w-fit rounded-lg border px-4 py-2">
            {t("pair.download")}
          </Link>
          <p className="text-sm text-neutral-600">{t("pair.later")}</p>
        </div>
      ) : null}

      <div className="flex gap-3">
        {i > 0 ? (
          <button className="rounded-lg border px-4 py-2" onClick={() => setI(i - 1)}>
            {tc("back")}
          </button>
        ) : null}
        {step === "companion" ? (
          <button
            className="rounded-lg border px-4 py-2"
            onClick={() => {
              set("avatar", DEFAULT_COMPANION);
              saveSettings({ ...values, avatar: DEFAULT_COMPANION });
              setI(i + 1);
            }}
          >
            {tc("skip")}
          </button>
        ) : null}
        <button
          className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
          disabled={step === "signIn" && !signedIn}
          onClick={next}
        >
          {i === STEPS.length - 1 ? tc("finish") : tc("continue")}
        </button>
      </div>
    </div>
  );
};
