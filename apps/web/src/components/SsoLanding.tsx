"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { env } from "@/lib/env";
import { hubLaunchUrl } from "@/lib/hub";
import { takeNext } from "@/lib/next-cookie";
import { completeSso } from "@/lib/sso";
import { supabase } from "@/lib/supabase";

/** Exchanges the hub launch token once, then leaves for the (relative-only) `next`. */
export const SsoLanding = () => {
  const t = useTranslations("sso");
  const [failed, setFailed] = useState<null | "missing" | "failed">(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token");
    const next = url.searchParams.get("next");
    // Drop the single-use token from the address bar and history right away.
    window.history.replaceState(null, "", url.pathname);
    let client;
    try {
      client = supabase();
    } catch {
      setFailed("failed");
      return;
    }
    void completeSso(
      { token, next },
      { apiBase: env.apiBase, fetch: window.fetch.bind(window), auth: client.auth },
    ).then((r) => {
      // The token's own `next` wins; else where the person was going before the hub sign-in
      // (the hub drops `next`, so Chalito remembered it in the chalito_next cookie).
      const remembered = takeNext();
      if (r.ok) window.location.replace(next ? r.next : (remembered ?? "/"));
      else setFailed(r.reason === "missing_token" ? "missing" : "failed");
    });
  }, []);
  if (!failed) return <p aria-live="polite">{t("working")}</p>;
  return (
    <div className="grid gap-3" role="alert">
      <p>{failed === "missing" ? t("missingToken") : t("failed")}</p>
      {hubLaunchUrl() ? (
        <a className="w-fit rounded-lg border px-4 py-2" href={hubLaunchUrl()!}>
          {t("retry")}
        </a>
      ) : null}
    </div>
  );
};
