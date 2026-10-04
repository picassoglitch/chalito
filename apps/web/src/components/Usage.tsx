"use client";
import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Usage as UsageData, UsageDay } from "@/lib/usage";
import { useChalito } from "./ChalitoProvider";

const RANGES = [7, 30] as const;
type Range = (typeof RANGES)[number];

const H = 120;

/** Stacked daily bars (SVG; no chart library). `parts` are drawn bottom-up. */
const Bars = ({
  days,
  parts,
  label,
  testId,
}: {
  days: UsageDay[];
  parts: { value: (d: UsageDay) => number; className: string }[];
  label: string;
  testId: string;
}) => {
  const max = Math.max(1, ...days.map((d) => parts.reduce((a, p) => a + p.value(d), 0)));
  const w = 100 / days.length;
  return (
    <svg
      viewBox={`0 0 100 ${H}`}
      preserveAspectRatio="none"
      className="h-32 w-full"
      role="img"
      aria-label={label}
      data-testid={testId}
    >
      {days.map((d, i) => {
        let y = H;
        return (
          <g key={d.day} data-day={d.day}>
            {parts.map((p, j) => {
              const h = (p.value(d) / max) * (H - 4);
              y -= h;
              return h > 0 ? (
                <rect key={j} x={i * w + w * 0.15} y={y} width={w * 0.7} height={h} className={p.className} />
              ) : null;
            })}
          </g>
        );
      })}
    </svg>
  );
};

/** Communication's daily share with the target as a dashed line. The scale tops out at 2× the target. */
const ShareChart = ({ days, target, label }: { days: UsageDay[]; target: number; label: string }) => {
  const top = Math.max(target * 2, ...days.map((d) => d.commsShare ?? 0));
  const w = 100 / days.length;
  const y = (v: number) => H - (v / top) * (H - 4);
  return (
    <svg
      viewBox={`0 0 100 ${H}`}
      preserveAspectRatio="none"
      className="h-24 w-full"
      role="img"
      aria-label={label}
      data-testid="usage-share-chart"
    >
      {days.map((d, i) =>
        d.commsShare === null ? null : (
          <rect
            key={d.day}
            x={i * w + w * 0.15}
            y={y(d.commsShare)}
            width={w * 0.7}
            height={H - y(d.commsShare)}
            className={d.commsShare > target ? "fill-amber-500" : "fill-sky-500"}
          />
        ),
      )}
      <line
        x1={0}
        x2={100}
        y1={y(target)}
        y2={y(target)}
        className="stroke-neutral-800"
        strokeWidth={0.6}
        strokeDasharray="2 1.5"
        vectorEffect="non-scaling-stroke"
        data-testid="usage-target-line"
      />
    </svg>
  );
};

/**
 * /uso: how many tokens Chalito used, per day. "Trabajo" is the work itself; "Comunicación" is
 * what it costs to keep you informed (briefs, messages, calls), which should stay under the
 * target share. "Tus claves" (your own provider keys) is shown apart: it uses no Chalito tokens.
 * Tokens only, never money: the hub sells tokens.
 */
export const Usage = () => {
  const t = useTranslations("usage");
  const locale = useLocale();
  const { usage } = useChalito();
  const [range, setRange] = useState<Range>(30);
  const [data, setData] = useState<UsageData | "error" | null>(null);

  const load = useCallback(() => {
    if (!usage) return () => undefined;
    let alive = true;
    setData(null);
    void usage(range).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [usage, range]);
  useEffect(load, [load]);

  const n = new Intl.NumberFormat(locale);
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const dayLabel = (d: string) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(d));

  const head = (
    <div className="flex flex-wrap items-center gap-2">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <div className="ml-auto flex gap-1" role="group" aria-label={t("range")}>
        {RANGES.map((r) => (
          <button
            key={r}
            aria-pressed={range === r}
            data-testid={`usage-range-${r}`}
            className={`rounded-lg border px-3 py-1 text-sm ${range === r ? "bg-neutral-900 text-white" : ""}`}
            onClick={() => setRange(r)}
          >
            {t("days", { n: r })}
          </button>
        ))}
      </div>
    </div>
  );

  if (data === null)
    return (
      <div className="grid gap-4">
        {head}
        <p aria-live="polite">{t("loading")}</p>
      </div>
    );
  if (data === "error")
    return (
      <div className="grid gap-4">
        {head}
        <div role="alert" data-testid="usage-error" className="grid gap-2 rounded-lg bg-red-50 p-4 text-red-900">
          <p>{t("error")}</p>
          <button className="w-fit rounded-lg border border-red-800 px-3 py-1" onClick={() => load()}>
            {t("retry")}
          </button>
        </div>
      </div>
    );

  const work = data.days.reduce((a, d) => a + d.managed.work.tokens, 0);
  const comms = data.days.reduce((a, d) => a + d.managed.comms.tokens, 0);
  const ratio = data.commsOverheadRatio;
  const over = ratio !== null && ratio > data.target;
  const empty = data.totals.managedTokens === 0 && data.totals.byoTokens === 0;

  return (
    <div className="grid gap-6" data-testid="usage">
      {head}
      <p className="text-sm text-neutral-600">{t("intro")}</p>
      {empty ? (
        <p data-testid="usage-empty" className="rounded-lg border p-4">
          {t("empty")}
        </p>
      ) : null}

      <section className="grid gap-3 rounded-xl border bg-white p-4" aria-labelledby="usage-chalito">
        <h2 id="usage-chalito" className="font-semibold">
          {t("chalito.title")}
        </h2>
        <p className="text-3xl font-bold" data-testid="usage-managed-total">
          {t("tokens", { n: n.format(data.totals.managedTokens) })}
        </p>
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <li className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-3 w-3 rounded-sm bg-emerald-600" />
            {t("chalito.work")}: <span data-testid="usage-work">{n.format(work)}</span>
          </li>
          <li className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-3 w-3 rounded-sm bg-sky-500" />
            {t("chalito.comms")}: <span data-testid="usage-comms">{n.format(comms)}</span>
          </li>
        </ul>
        <Bars
          days={data.days}
          testId="usage-managed-chart"
          label={t("chalito.chartLabel", { days: data.days.length })}
          parts={[
            { value: (d) => d.managed.work.tokens, className: "fill-emerald-600" },
            { value: (d) => d.managed.comms.tokens, className: "fill-sky-500" },
          ]}
        />
        <div className="flex justify-between text-xs text-neutral-500" aria-hidden>
          <span>{data.days[0] ? dayLabel(data.days[0].day) : ""}</span>
          <span>{data.days.at(-1) ? dayLabel(data.days.at(-1)!.day) : ""}</span>
        </div>
      </section>

      <section className="grid gap-3 rounded-xl border bg-white p-4" aria-labelledby="usage-share">
        <h2 id="usage-share" className="font-semibold">
          {t("share.title")}
        </h2>
        {ratio === null ? (
          <p className="text-sm text-neutral-600">{t("share.none")}</p>
        ) : (
          <>
            <p data-testid="usage-share" data-over={over}>
              {t("share.value", { share: pct.format(ratio), target: pct.format(data.target) })}
            </p>
            <div
              className="relative h-3 rounded-full bg-neutral-100"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(ratio * 1000) / 10}
              aria-label={t("share.title")}
            >
              <div
                className={`h-3 rounded-full ${over ? "bg-amber-500" : "bg-sky-500"}`}
                style={{ width: `${Math.min(100, (ratio / (data.target * 2)) * 100)}%` }}
              />
              {/* The target sits at the middle: the meter's scale is twice the target. */}
              <div aria-hidden className="absolute inset-y-[-4px] left-1/2 w-0.5 bg-neutral-800" />
            </div>
            <p className={`text-sm ${over ? "text-amber-900" : "text-neutral-600"}`} role={over ? "note" : undefined}>
              {over ? t("share.over") : t("share.under")}
            </p>
            <ShareChart
              days={data.days}
              target={data.target}
              label={t("share.chartLabel", { target: pct.format(data.target) })}
            />
          </>
        )}
      </section>

      <section className="grid gap-3 rounded-xl border bg-white p-4" aria-labelledby="usage-byo">
        <h2 id="usage-byo" className="font-semibold">
          {t("byo.title")}
        </h2>
        <p className="text-sm text-neutral-600">{t("byo.body")}</p>
        <p className="text-xl font-bold" data-testid="usage-byo-total">
          {t("tokens", { n: n.format(data.totals.byoTokens) })}
        </p>
        {data.totals.byoTokens > 0 ? (
          <Bars
            days={data.days}
            testId="usage-byo-chart"
            label={t("byo.chartLabel", { days: data.days.length })}
            parts={[{ value: (d) => d.byo.tokens, className: "fill-neutral-500" }]}
          />
        ) : null}
      </section>

      <details className="rounded-xl border bg-white p-4">
        <summary className="cursor-pointer font-medium">{t("table.title")}</summary>
        <table className="mt-3 w-full text-sm" data-testid="usage-table">
          <thead>
            <tr className="text-left text-neutral-600">
              <th className="py-1 font-medium">{t("table.day")}</th>
              <th className="py-1 text-right font-medium">{t("chalito.work")}</th>
              <th className="py-1 text-right font-medium">{t("chalito.comms")}</th>
              <th className="py-1 text-right font-medium">{t("byo.title")}</th>
            </tr>
          </thead>
          <tbody>
            {[...data.days].reverse().map((d) => (
              <tr key={d.day} className="border-t">
                <td className="py-1">{dayLabel(d.day)}</td>
                <td className="py-1 text-right tabular-nums">{compact.format(d.managed.work.tokens)}</td>
                <td className="py-1 text-right tabular-nums">{compact.format(d.managed.comms.tokens)}</td>
                <td className="py-1 text-right tabular-nums">{compact.format(d.byo.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
};
