import { useEffect, useState } from "react";
import { DOWNLOAD_OSES, ReleaseManifest, type DownloadOs } from "./manifest.js";
import { detectPlatform, type DetectedPlatform, type NavigatorLike } from "./detect.js";

/** `t(key, values)` over this package's messages (es/en), e.g. next-intl's `useTranslations("download")`. */
export type DownloadText = (key: string, values?: Record<string, string | number>) => string;

/**
 * Fetches the channel manifest through the api (which returns signed, short-lived URLs).
 * Returns null when there's no release yet or the manifest is malformed.
 */
export const fetchManifest = async (
  apiBase: string,
  channel: "stable" | "beta" = "stable",
  f: typeof fetch = fetch,
): Promise<ReleaseManifest | null> => {
  try {
    const res = await f(`${apiBase.replace(/\/+$/, "")}/releases/${channel}/latest.json`, { credentials: "omit" });
    if (!res.ok) return null;
    const m = ReleaseManifest.safeParse(await res.json());
    return m.success ? m.data : null;
  } catch {
    return null;
  }
};

/**
 * /descargar: offers the detected OS's installers first, with a manual switch. Shows the
 * version, sizes and SHA-256 checksums, an unsigned warning when the build wasn't signed, and
 * the SmartScreen note for Windows (ADR 0014). `manifest` undefined = still loading.
 */
export const DownloadPanel = ({
  manifest,
  t,
  navigator: nav = typeof navigator === "undefined" ? undefined : (navigator as NavigatorLike),
}: {
  manifest: ReleaseManifest | null | undefined;
  t: DownloadText;
  navigator?: NavigatorLike;
}) => {
  const [detected, setDetected] = useState<DetectedPlatform>("unknown");
  const [chosen, setChosen] = useState<DownloadOs | null>(null);
  // Detection runs on the client only (no hydration mismatch when the page is server-rendered).
  useEffect(() => setDetected(detectPlatform(nav)), [nav]);

  if (manifest === undefined) return <p>{t("loading")}</p>;
  if (manifest === null) return <p role="status">{t("unavailable")}</p>;
  const desktop = (DOWNLOAD_OSES as readonly string[]).includes(detected) ? (detected as DownloadOs) : null;
  const os: DownloadOs = chosen ?? desktop ?? "windows";
  const files = manifest.downloads?.[os] ?? [];

  return (
    <section data-download-os={os} className="grid gap-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      {desktop && <p>{t("detected", { os: t(`os.${desktop}`) })}</p>}
      {(detected === "ios" || detected === "android") && <p role="note">{t("mobile")}</p>}
      <div role="radiogroup" aria-label={t("choose")} className="flex gap-2">
        {DOWNLOAD_OSES.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={o === os} onClick={() => setChosen(o)}>
            {t(`os.${o}`)}
          </button>
        ))}
      </div>
      <p className="text-sm">{t("version", { version: manifest.version })}</p>
      {manifest.unsigned?.[os] && (
        <p role="note" data-unsigned>
          {t("unsigned")}
        </p>
      )}
      {files.length === 0 ? (
        <p role="status">{t("unavailable")}</p>
      ) : (
        <ul className="grid gap-3">
          {files.map((f) => (
            <li key={f.name} data-kind={f.kind} className="grid gap-1">
              <a href={f.url} download={f.name} rel="noopener">
                {t(`kinds.${f.kind}`)}
              </a>
              <span className="text-xs">
                {f.name} · {t("size", { mb: (f.size / 1_048_576).toFixed(1) })}
              </span>
              <code className="text-xs break-all" title={t("checksum")}>
                {f.sha256}
              </code>
            </li>
          ))}
        </ul>
      )}
      {os === "windows" && <p className="text-sm">{t("smartscreen")}</p>}
    </section>
  );
};
