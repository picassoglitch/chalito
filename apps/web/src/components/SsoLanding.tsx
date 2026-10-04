"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { env } from "@/lib/env";
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
      if (r.ok) window.location.replace(r.next);
      else setFailed(r.reason === "missing_token" ? "missing" : "failed");
    });
  }, []);
  if (!failed) return <p aria-live="polite">{t("working")}</p>;
  return (
    <div className="grid gap-3" role="alert">
      <p>{failed === "missing" ? t("missingToken") : t("failed")}</p>
      {env.hubUrl ? (
        <a className="w-fit rounded-lg border px-4 py-2" href={env.hubUrl}>
          {t("retry")}
        </a>
      ) : null}
    </div>
  );
};
