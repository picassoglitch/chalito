"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { DownloadPanel, fetchManifest } from "@chalito/releases/download";
import type { ReleaseManifest } from "@chalito/releases";
import { env } from "@/lib/env";

/**
 * Only signed https links are offered: the api swaps the manifest's bucket paths for short-lived
 * signed URLs, so anything else (a raw path, another scheme) is a broken or tampered manifest.
 */
export const httpsOnly = (m: ReleaseManifest | null): ReleaseManifest | null => {
  if (!m?.downloads) return m;
  const downloads = Object.fromEntries(
    Object.entries(m.downloads).map(([os, files]) => [os, (files ?? []).filter((f) => /^https:\/\//.test(f.url))]),
  ) as ReleaseManifest["downloads"];
  return { ...m, downloads };
};

/** /descargar: the desktop apps from the release manifest (@chalito/releases, ADR 0014). */
export const Download = () => {
  const t = useTranslations("download");
  const [manifest, setManifest] = useState<ReleaseManifest | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void fetchManifest(env.apiBase, "stable").then((m) => alive && setManifest(httpsOnly(m)));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div data-testid="download">
      <DownloadPanel manifest={manifest} t={(k, v) => t(k, v)} />
    </div>
  );
};
