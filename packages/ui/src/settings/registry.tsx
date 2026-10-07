import type { ReactNode } from "react";
import { useUiText } from "../text.js";
import {
  ChargesNotice,
  CompanionNameField,
  CompanionPicker,
  ConnectionsField,
  PhoneField,
  QuietHoursField,
  RenderQualityField,
  Toggle,
} from "./fields.js";
import { canOptIn, chargesApply, type PhoneVerifier, type SettingsValues } from "./values.js";

/** Where a settings panel is rendered. Every setting renders in both (brief M5 settings parity). */
export const SHELLS = ["web", "desktop"] as const;
export type Shell = (typeof SHELLS)[number];

export type SettingKey = keyof SettingsValues;

export interface SettingContext {
  values: SettingsValues;
  set: <K extends SettingKey>(key: K, value: SettingsValues[K]) => void;
  shell: Shell;
  /** Display name of a provider (from the integrations.* messages, the only place provider names may appear). */
  providerLabel: (provider: string) => string;
  /** Where plans and credits are managed: the Chalyb hub. Prices never live in Chalito code. */
  hubPlansUrl: string;
  /** Where this shell shows token usage (the PWA's /uso), if it has such a page. */
  usageHref?: string;
  /** Sends and checks phone codes (the api in the PWA, a mock in tests). */
  phoneVerifier: PhoneVerifier;
  /** Shown under the companion picker, e.g. the PWA's "Crea tu personaje" (custom companion from a photo). */
  companionExtra?: ReactNode;
  /** The companion wears the person's own custom character (see CompanionPicker). */
  customCompanion?: boolean;
}

export interface SettingDef {
  key: SettingKey;
  section: "contact" | "companion" | "privacy" | "account" | "display";
  render: (ctx: SettingContext) => ReactNode;
}

const Labelled = ({ k, children }: { k: string; children: ReactNode }) => {
  const { t } = useUiText();
  return (
    <div className="grid gap-2">
      <span className="font-medium">{t(`${k}.label`)}</span>
      {children}
    </div>
  );
};

const PlanCredits = ({ ctx }: { ctx: SettingContext }) => {
  const { t } = useUiText();
  const { tier, trialEndsAt } = ctx.values.planCredits;
  return (
    <Labelled k="planCredits">
      <p>{tier ? t("planCredits.tier", { tier }) : t("planCredits.unknown")}</p>
      {trialEndsAt ? <p className="text-sm text-neutral-600">{t("planCredits.trial", { date: trialEndsAt })}</p> : null}
      {ctx.usageHref ? (
        <a className="text-emerald-700 underline" href={ctx.usageHref} data-testid="usage-link">
          {t("planCredits.usage")}
        </a>
      ) : null}
      <a className="text-emerald-700 underline" href={ctx.hubPlansUrl} rel="noopener">
        {t("planCredits.manage")}
      </a>
    </Labelled>
  );
};

const PhoneToggle = ({ ctx, k }: { ctx: SettingContext; k: "whatsapp" | "calls" }) => {
  const { t } = useUiText();
  const allowed = canOptIn(ctx.values);
  return (
    <Toggle
      label={t(`${k}.label`)}
      hint={!ctx.values.phone.verified ? t("needsPhone") : !ctx.values.chargesAck ? t("needsAck") : t(`${k}.hint`)}
      checked={ctx.values[k] && allowed}
      disabled={!allowed}
      onChange={(on) => ctx.set(k, on)}
    >
      {ctx.values[k] && allowed && chargesApply(ctx.values) ? <ChargesNotice /> : null}
    </Toggle>
  );
};

/** The notice plus an explicit "I understand": required before a code can even be sent. */
const ChargesAck = ({ ctx }: { ctx: SettingContext }) => {
  const { t } = useUiText();
  return (
    <div>
      <ChargesNotice />
      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={ctx.values.chargesAck}
          onChange={(e) => {
            ctx.set("chargesAck", e.target.checked);
            // Withdrawing the acknowledgement turns the paid channels off.
            if (!e.target.checked) {
              ctx.set("whatsapp", false);
              ctx.set("calls", false);
            }
          }}
        />
        <span>{t("chargesAck")}</span>
      </label>
    </div>
  );
};

const PlainToggle = ({ ctx, k }: { ctx: SettingContext; k: "callBriefing" | "privacyMode" }) => {
  const { t } = useUiText();
  return (
    <Toggle label={t(`${k}.label`)} hint={t(`${k}.hint`)} checked={ctx.values[k]} onChange={(on) => ctx.set(k, on)}>
      {k === "callBriefing" && ctx.values.callBriefing ? (
        <p role="note" className="mt-2 text-sm text-amber-900">
          {t("callBriefing.plaintext")}
        </p>
      ) : null}
    </Toggle>
  );
};

/**
 * THE settings registry (brief M5 "settings parity"). Both the PWA and the desktop panel
 * render exactly these entries; the parity test enumerates this list.
 */
export const SETTINGS: readonly SettingDef[] = [
  { key: "chargesAck", section: "contact", render: (ctx) => <ChargesAck ctx={ctx} /> },
  {
    key: "phone",
    section: "contact",
    render: (ctx) => (
      <Labelled k="phone">
        <PhoneField
          value={ctx.values.phone}
          onChange={(v) => ctx.set("phone", v)}
          verifier={ctx.phoneVerifier}
          chargesAck={ctx.values.chargesAck}
        />
      </Labelled>
    ),
  },
  { key: "whatsapp", section: "contact", render: (ctx) => <PhoneToggle ctx={ctx} k="whatsapp" /> },
  { key: "calls", section: "contact", render: (ctx) => <PhoneToggle ctx={ctx} k="calls" /> },
  { key: "callBriefing", section: "contact", render: (ctx) => <PlainToggle ctx={ctx} k="callBriefing" /> },
  {
    key: "quietHours",
    section: "contact",
    render: (ctx) => <QuietHoursField value={ctx.values.quietHours} onChange={(v) => ctx.set("quietHours", v)} />,
  },
  {
    key: "avatar",
    section: "companion",
    render: (ctx) => (
      <Labelled k="avatar">
        <CompanionPicker
          value={ctx.values.avatar}
          onChange={(v) => ctx.set("avatar", v)}
          customActive={!!ctx.customCompanion}
        />
        {ctx.companionExtra}
      </Labelled>
    ),
  },
  {
    key: "companionName",
    section: "companion",
    render: (ctx) => (
      <CompanionNameField value={ctx.values.companionName} onChange={(v) => ctx.set("companionName", v)} />
    ),
  },
  { key: "privacyMode", section: "privacy", render: (ctx) => <PlainToggle ctx={ctx} k="privacyMode" /> },
  {
    key: "connections",
    section: "privacy",
    render: (ctx) => (
      <Labelled k="connections">
        <ConnectionsField value={ctx.values.connections} providerLabel={ctx.providerLabel} />
      </Labelled>
    ),
  },
  { key: "planCredits", section: "account", render: (ctx) => <PlanCredits ctx={ctx} /> },
  {
    key: "renderQuality",
    section: "display",
    render: (ctx) => (
      <RenderQualityField value={ctx.values.renderQuality} onChange={(v) => ctx.set("renderQuality", v)} />
    ),
  },
];

export const SECTIONS = ["contact", "companion", "privacy", "account", "display"] as const;

/** Renders every registered setting, grouped by section. */
export const SettingsPanel = (props: Omit<SettingContext, "set"> & { onChange: SettingContext["set"] }) => {
  const { t } = useUiText();
  const ctx: SettingContext = { ...props, set: props.onChange };
  return (
    <div data-shell={props.shell} className="grid gap-8">
      {SECTIONS.map((section) => (
        <section key={section} aria-labelledby={`settings-${section}`} className="grid gap-5">
          <h2 id={`settings-${section}`} className="text-lg font-semibold">
            {t(`sections.${section}`)}
          </h2>
          {SETTINGS.filter((s) => s.section === section).map((s) => (
            <div key={s.key} data-setting-key={s.key}>
              {s.render(ctx)}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
};
