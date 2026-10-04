import { useId, useMemo, useState, type ReactNode } from "react";
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { formatCompanionTitle } from "@chalito/brand";
import { COMPANIONS, type CompanionId } from "../companions.js";
import { useUiText } from "../text.js";
import { RENDER_QUALITIES, type ConnectionStatus, type RenderQuality } from "./values.js";

/** "Pueden aplicar cargos" / "Charges may apply": shown wherever calls, SMS or WhatsApp are on. */
export const ChargesNotice = () => {
  const { t } = useUiText();
  return (
    <p
      role="note"
      data-testid="charges-notice"
      className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      {t("charges")}
    </p>
  );
};

export const Toggle = ({
  label,
  hint,
  checked,
  disabled,
  onChange,
  children,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
}) => {
  const id = useId();
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <label htmlFor={id} className="font-medium">
          {label}
          {hint ? <span className="block text-sm font-normal text-neutral-600">{hint}</span> : null}
        </label>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="mt-1 h-5 w-5"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      </div>
      {children}
    </div>
  );
};

/** Any country code (libphonenumber-js metadata); stores E.164 only when valid. */
export const PhoneField = ({ value, onChange }: { value: string | null; onChange: (e164: string | null) => void }) => {
  const { t, locale } = useUiText();
  const parsed = value ? parsePhoneNumberFromString(value) : undefined;
  const [country, setCountry] = useState<CountryCode>(parsed?.country ?? (locale === "es" ? "MX" : "US"));
  const [national, setNational] = useState(parsed?.nationalNumber ?? "");
  const [invalid, setInvalid] = useState(false);
  const countryId = useId();
  const numberId = useId();
  const names = useMemo(() => new Intl.DisplayNames([locale], { type: "region" }), [locale]);
  const countries = useMemo(
    () => getCountries().sort((a, b) => (names.of(a) ?? a).localeCompare(names.of(b) ?? b, locale)),
    [names, locale],
  );

  const commit = (c: CountryCode, n: string) => {
    if (!n.trim()) {
      setInvalid(false);
      onChange(null);
      return;
    }
    const p = parsePhoneNumberFromString(n, c);
    const ok = !!p && p.isValid();
    setInvalid(!ok);
    onChange(ok ? p.number : null);
  };

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_1fr]">
      <label htmlFor={countryId} className="sr-only">
        {t("phone.country")}
      </label>
      <select
        id={countryId}
        className="rounded-md border px-2 py-2"
        value={country}
        onChange={(e) => {
          const c = e.target.value as CountryCode;
          setCountry(c);
          commit(c, national);
        }}
      >
        {countries.map((c) => (
          <option key={c} value={c}>
            {names.of(c) ?? c} (+{getCountryCallingCode(c)})
          </option>
        ))}
      </select>
      <label htmlFor={numberId} className="sr-only">
        {t("phone.number")}
      </label>
      <input
        id={numberId}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        className="rounded-md border px-3 py-2"
        placeholder={t("phone.placeholder")}
        value={national}
        aria-invalid={invalid}
        onChange={(e) => {
          setNational(e.target.value);
          commit(country, e.target.value);
        }}
      />
      {invalid ? (
        <p role="alert" className="text-sm text-red-700 sm:col-span-2">
          {t("phone.invalid")}
        </p>
      ) : null}
    </div>
  );
};

export const CompanionPicker = ({ value, onChange }: { value: CompanionId; onChange: (c: CompanionId) => void }) => {
  const { t } = useUiText();
  return (
    <div role="radiogroup" aria-label={t("avatar.label")} className="grid grid-cols-3 gap-3">
      {COMPANIONS.map((c) => (
        <label
          key={c}
          className={`cursor-pointer rounded-xl border p-3 text-center ${value === c ? "border-emerald-600 ring-2 ring-emerald-600" : ""}`}
        >
          <input
            type="radio"
            name="companion"
            className="sr-only"
            value={c}
            checked={value === c}
            onChange={() => onChange(c)}
          />
          <span aria-hidden className="mx-auto mb-2 block h-12 w-12 rounded-full bg-emerald-100" />
          <span className="text-sm font-medium">{t(`companions.${c}`)}</span>
        </label>
      ))}
    </div>
  );
};

/** Name input with the live title and credit line (packages/brand, D-028). */
export const CompanionNameField = ({
  value,
  onChange,
}: {
  value: { name: string; isRenamed: boolean };
  onChange: (v: { name: string; isRenamed: boolean }) => void;
}) => {
  const { t, locale } = useUiText();
  const id = useId();
  const title = formatCompanionTitle(value.name, value.isRenamed, locale);
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="font-medium">
        {t("companionName.label")}
      </label>
      <input
        id={id}
        className="rounded-md border px-3 py-2"
        maxLength={80}
        placeholder={t("companionName.placeholder")}
        value={value.name}
        onChange={(e) => onChange({ name: e.target.value, isRenamed: e.target.value.trim().length > 0 })}
      />
      <p data-testid="companion-title" className="text-lg font-semibold">
        {title.title}
      </p>
      {title.credit ? (
        <p data-testid="credit-line" className="text-sm text-neutral-600">
          {title.credit}
        </p>
      ) : null}
    </div>
  );
};

export const QuietHoursField = ({
  value,
  onChange,
}: {
  value: { enabled: boolean; from: string; to: string };
  onChange: (v: { enabled: boolean; from: string; to: string }) => void;
}) => {
  const { t } = useUiText();
  const fromId = useId();
  const toId = useId();
  return (
    <Toggle
      label={t("quietHours.label")}
      hint={t("quietHours.hint")}
      checked={value.enabled}
      onChange={(enabled) => onChange({ ...value, enabled })}
    >
      {value.enabled ? (
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor={fromId}>{t("quietHours.from")}</label>
          <input
            id={fromId}
            type="time"
            className="rounded-md border px-2 py-1"
            value={value.from}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
          />
          <label htmlFor={toId}>{t("quietHours.to")}</label>
          <input
            id={toId}
            type="time"
            className="rounded-md border px-2 py-1"
            value={value.to}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
          />
        </div>
      ) : null}
    </Toggle>
  );
};

export const RenderQualityField = ({
  value,
  onChange,
}: {
  value: RenderQuality;
  onChange: (q: RenderQuality) => void;
}) => {
  const { t } = useUiText();
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={id} className="font-medium">
        {t("renderQuality.label")}
      </label>
      <select
        id={id}
        className="rounded-md border px-2 py-2"
        value={value}
        onChange={(e) => onChange(e.target.value as RenderQuality)}
      >
        {RENDER_QUALITIES.map((q) => (
          <option key={q} value={q}>
            {t(`renderQuality.${q}`)}
          </option>
        ))}
      </select>
    </div>
  );
};

/** BYO connections: mode and status per provider, never a secret. Provider names live under integrations.*. */
export const ConnectionsField = ({
  value,
  providerLabel,
}: {
  value: ConnectionStatus[];
  providerLabel: (provider: string) => string;
}) => {
  const { t } = useUiText();
  if (value.length === 0) return <p className="text-sm text-neutral-600">{t("connections.none")}</p>;
  return (
    <ul className="divide-y rounded-md border">
      {value.map((c) => (
        <li key={c.provider} className="flex items-center justify-between px-3 py-2">
          <span>{providerLabel(c.provider)}</span>
          <span className="text-sm text-neutral-600">
            {c.connected ? t(`connections.mode.${c.mode}`) : t("connections.notConnected")}
          </span>
        </li>
      ))}
    </ul>
  );
};
