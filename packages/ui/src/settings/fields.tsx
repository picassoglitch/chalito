import { useId, useMemo, useState, type ReactNode } from "react";
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { formatCompanionTitle } from "@chalito/brand";
import { CATEGORIES, rosterEntry, searchRoster, type Category } from "@chalito/roster";
import { companionName, type CompanionId } from "../companions.js";
import { useRosterAsset } from "../roster-assets.js";
import { useUiText } from "../text.js";
import {
  RENDER_QUALITIES,
  type ConnectionStatus,
  type PhoneVerifier,
  type QuietHours,
  type RenderQuality,
} from "./values.js";

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

type PhoneValue = { e164: string | null; verified: boolean };

/**
 * Any country code (libphonenumber-js metadata). The flow follows the server rule: the browser
 * proposes a number, the api sends a code ("Te enviaremos un código"), and only a correct code
 * makes it verified. Nothing here marks a number verified on its own.
 */
export const PhoneField = ({
  value,
  onChange,
  verifier,
  chargesAck,
}: {
  value: PhoneValue;
  onChange: (v: PhoneValue) => void;
  verifier: PhoneVerifier;
  /** The api refuses to send a code before the charges notice is acknowledged. */
  chargesAck: boolean;
}) => {
  const { t, locale } = useUiText();
  const parsed = value.e164 ? parsePhoneNumberFromString(value.e164) : undefined;
  const [country, setCountry] = useState<CountryCode>(parsed?.country ?? (locale === "es" ? "MX" : "US"));
  const [national, setNational] = useState(parsed?.nationalNumber ?? "");
  const [stage, setStage] = useState<"edit" | "code" | "done">(value.verified ? "done" : "edit");
  const [pending, setPending] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<"sms" | "call">("sms");
  const countryId = useId();
  const numberId = useId();
  const codeId = useId();
  const names = useMemo(() => new Intl.DisplayNames([locale], { type: "region" }), [locale]);
  const countries = useMemo(
    () => getCountries().sort((a, b) => (names.of(a) ?? a).localeCompare(names.of(b) ?? b, locale)),
    [names, locale],
  );

  const send = async () => {
    const p = parsePhoneNumberFromString(national, country);
    if (!p || !p.isValid()) return setError(t("phone.invalid"));
    setBusy(true);
    setError(null);
    const r = await verifier.start(p.number, { channel, locale });
    setBusy(false);
    if (!r.ok)
      return setError(
        t(
          r.reason === "invalid"
            ? "phone.invalid"
            : r.reason === "rate_limited"
              ? "phone.rateLimited"
              : r.reason === "charges_notice_required"
                ? "needsAck"
                : "phone.error",
        ),
      );
    setPending(p.number);
    setCode("");
    setStage("code");
  };
  const check = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    const r = await verifier.check(pending, code.trim());
    setBusy(false);
    if (!r.ok)
      return setError(
        t(r.reason === "wrong_code" ? "phone.wrongCode" : r.reason === "in_use" ? "phone.inUse" : "phone.error"),
      );
    onChange({ e164: pending, verified: true });
    setStage("done");
  };

  const verifiedNumber = value.verified ? value.e164 : stage === "done" ? pending : null;
  if (stage === "done" && verifiedNumber)
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span data-testid="phone-verified">{t("phone.verified", { number: verifiedNumber })}</span>
        <button
          type="button"
          className="rounded-md border px-3 py-1 text-sm"
          onClick={() => {
            setStage("edit");
            setError(null);
          }}
        >
          {t("phone.change")}
        </button>
      </div>
    );

  if (stage === "code")
    return (
      <div className="grid gap-2">
        <p>{t("phone.codeSent", { number: pending ?? "" })}</p>
        <label htmlFor={codeId}>{t("phone.code")}</label>
        <input
          id={codeId}
          inputMode="numeric"
          autoComplete="one-time-code"
          className="w-40 rounded-md border px-3 py-2 tracking-widest"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md bg-emerald-700 px-3 py-1 text-white disabled:opacity-50"
            disabled={busy || code.length < 4}
            onClick={() => void check()}
          >
            {t("phone.verify")}
          </button>
          <button type="button" className="rounded-md border px-3 py-1" onClick={() => setStage("edit")}>
            {t("phone.change")}
          </button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </div>
    );

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_1fr]">
      <label htmlFor={countryId} className="sr-only">
        {t("phone.country")}
      </label>
      <select
        id={countryId}
        className="rounded-md border px-2 py-2"
        value={country}
        onChange={(e) => setCountry(e.target.value as CountryCode)}
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
        aria-invalid={!!error}
        onChange={(e) => setNational(e.target.value)}
      />
      <div className="grid gap-2 sm:col-span-2">
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="sr-only">{t("phone.channel")}</legend>
          {(["sms", "call"] as const).map((c) => (
            <label key={c} className="flex items-center gap-1">
              <input type="radio" name="otp-channel" checked={channel === c} onChange={() => setChannel(c)} />
              {t(`phone.by.${c}`)}
            </label>
          ))}
        </fieldset>
        <p className="text-sm text-neutral-600">{t(channel === "sms" ? "phone.willSend" : "phone.willCall")}</p>
        {!chargesAck ? <p className="text-sm text-amber-900">{t("needsAck")}</p> : null}
        <button
          type="button"
          className="w-fit rounded-md bg-emerald-700 px-3 py-1 text-white disabled:opacity-50"
          disabled={busy || !national.trim() || !chargesAck}
          onClick={() => void send()}
        >
          {t("phone.sendCode")}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-700 sm:col-span-2">
          {error}
        </p>
      ) : null}
    </div>
  );
};

/**
 * The companion picker: 220 free companions in 11 categories (@chalito/roster's catalog). Category
 * chips scroll sideways on phones, a search finds a name in Spanish or English (it looks in every
 * category), and the grid's pictures load lazily as they scroll into view. It opens on the chosen
 * companion's category so the selection is visible.
 */
export const CompanionPicker = ({
  value,
  onChange,
  customActive = false,
}: {
  value: CompanionId;
  onChange: (c: CompanionId) => void;
  /**
   * The companion wears the person's own custom character (the PWA's "Crea tu personaje"): no roster
   * companion shows as chosen, and picking any of them (the one underneath too) switches back.
   */
  customActive?: boolean;
}) => {
  const { t, locale } = useUiText();
  const asset = useRosterAsset();
  const searchId = useId();
  const [category, setCategory] = useState<Category | null>(() => rosterEntry(value)?.category ?? null);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => searchRoster(query, category), [query, category]);
  const selected = customActive ? undefined : rosterEntry(value);
  const chosen = (id: string) => !customActive && value === id;
  const chip = (active: boolean) =>
    `shrink-0 rounded-full border px-3 py-1 text-sm whitespace-nowrap ${active ? "border-emerald-700 bg-emerald-700 text-white" : "bg-white"}`;
  return (
    <div className="grid min-w-0 gap-3" data-testid="companion-picker">
      <label htmlFor={searchId} className="sr-only">
        {t("avatar.search")}
      </label>
      <input
        id={searchId}
        type="search"
        className="rounded-md border px-3 py-2"
        placeholder={t("avatar.searchPlaceholder")}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          // A name search looks in every category.
          if (e.target.value.trim()) setCategory(null);
        }}
      />
      <div
        role="group"
        aria-label={t("avatar.categories")}
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
        data-testid="companion-categories"
      >
        <button
          type="button"
          aria-pressed={category === null}
          className={chip(category === null)}
          onClick={() => setCategory(null)}
        >
          {t("avatar.all")}
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={category === c.id}
            data-category={c.id}
            className={chip(category === c.id)}
            onClick={() => {
              setCategory(c.id);
              setQuery("");
            }}
          >
            {c.label[locale]}
          </button>
        ))}
      </div>
      {customActive ? (
        <p className="text-sm text-neutral-600" data-testid="companion-custom" aria-live="polite">
          {t("avatar.custom")}
        </p>
      ) : null}
      {selected ? (
        <p className="text-sm text-neutral-600" data-testid="companion-selected" aria-live="polite">
          {t("avatar.selected", { name: companionName(selected.id, locale) })} {selected.blurb[locale]}
        </p>
      ) : null}
      {shown.length ? (
        <div
          role="radiogroup"
          aria-label={t("avatar.label")}
          className="grid max-h-[28rem] grid-cols-3 gap-2 overflow-y-auto p-1 sm:grid-cols-4"
        >
          {shown.map((r) => (
            <label
              key={r.id}
              title={r.blurb[locale]}
              className={`cursor-pointer rounded-xl border p-2 text-center ${chosen(r.id) ? "border-emerald-600 ring-2 ring-emerald-600" : ""}`}
            >
              <input
                type="radio"
                name="companion"
                className="sr-only"
                value={r.id}
                checked={chosen(r.id)}
                onChange={() => onChange(r.id)}
              />
              <span aria-hidden className="mx-auto mb-1 block h-16 w-16 overflow-hidden rounded-full bg-emerald-50">
                {asset ? (
                  <img
                    src={asset(r.thumbs[128])}
                    alt=""
                    width={64}
                    height={64}
                    loading="lazy"
                    decoding="async"
                    // Art still being generated: a missing picture leaves the plain swatch.
                    onError={(e) => {
                      e.currentTarget.style.visibility = "hidden";
                    }}
                    className="block h-16 w-16 object-cover object-top"
                  />
                ) : null}
              </span>
              <span className="block truncate text-sm font-medium">{companionName(r.id, locale)}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-sm text-neutral-600" data-testid="companion-empty">
          {t("avatar.empty")}
        </p>
      )}
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

export const QuietHoursField = ({ value, onChange }: { value: QuietHours; onChange: (v: QuietHours) => void }) => {
  const { t } = useUiText();
  const startId = useId();
  const endId = useId();
  return (
    <fieldset className="grid gap-2">
      <legend className="font-medium">{t("quietHours.label")}</legend>
      <p className="text-sm text-neutral-600">{t("quietHours.hint")}</p>
      {(["default", "custom", "off"] as const).map((m) => (
        <label key={m} className="flex items-center gap-2">
          <input
            type="radio"
            name="quiet-hours"
            checked={value.mode === m}
            onChange={() => onChange({ ...value, mode: m })}
          />
          {t(`quietHours.${m}`)}
        </label>
      ))}
      {value.mode === "custom" ? (
        <div className="flex items-center gap-2">
          <label htmlFor={startId}>{t("quietHours.from")}</label>
          <input
            id={startId}
            type="time"
            className="rounded-md border px-2 py-1"
            value={value.start}
            onChange={(e) => onChange({ ...value, start: e.target.value })}
          />
          <label htmlFor={endId}>{t("quietHours.to")}</label>
          <input
            id={endId}
            type="time"
            className="rounded-md border px-2 py-1"
            value={value.end}
            onChange={(e) => onChange({ ...value, end: e.target.value })}
          />
        </div>
      ) : null}
    </fieldset>
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
