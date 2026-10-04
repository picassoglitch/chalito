"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { handoffUrl, type DesktopHandoff } from "@/lib/desktop-sso";
import { env } from "@/lib/env";
import { hubLaunchUrl } from "@/lib/hub";
import { takeNext } from "@/lib/next-cookie";
import { completeSso } from "@/lib/sso";
import { supabase } from "@/lib/supabase";

/** The desktop handoff left by /auth/desktop (HttpOnly cookie, read and cleared server-side). */
const consumeDesktopHandoff = async (): Promise<DesktopHandoff | null> => {
  try {
    const r = await fetch("/auth/desktop/consume", { method: "POST", credentials: "same-origin" });
    return r.ok ? ((await r.json()) as { handoff: DesktopHandoff | null }).handoff : null;
  } catch {
    return null;
  }
};

/**
 * /auth/sso: the hub's launch token. Normally it's exchanged here once, then the person goes to the
 * (relative-only) `next`. If the desktop app started this sign-in (/auth/desktop), the token is
 * handed to the app instead and never exchanged in the browser.
 */
export const SsoLanding = () => {
  const t = useTranslations("sso");
  const [failed, setFailed] = useState<null | "missing" | "failed" | "rate_limited">(null);
  const [desktop, setDesktop] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token");
    const next = url.searchParams.get("next");
    // Drop the single-use token from the address bar and history right away.
    window.history.replaceState(null, "", url.pathname);

    const webSignIn = () => {
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
        else
          setFailed(r.reason === "missing_token" ? "missing" : r.reason === "rate_limited" ? "rate_limited" : "failed");
      });
    };

    void consumeDesktopHandoff().then((handoff) => {
      if (!handoff) return webSignIn();
      if (!token) return setFailed("missing");
      setDesktop(handoffUrl(handoff, token, next));
    });
  }, []);

  if (desktop)
    return (
      <div className="grid gap-3" data-testid="desktop-handoff">
        <h1 className="text-2xl font-bold">{t("desktop.title")}</h1>
        <p>{t("desktop.body")}</p>
        {/* A link the person clicks: browsers ask before opening a custom scheme like chalito://. */}
        <a className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white" href={desktop} rel="noreferrer">
          {t("desktop.open")}
        </a>
      </div>
    );
  if (!failed) return <p aria-live="polite">{t("working")}</p>;
  return (
    <div className="grid gap-3" role="alert">
      <p data-reason={failed}>
        {failed === "missing" ? t("missingToken") : failed === "rate_limited" ? t("rateLimited") : t("failed")}
      </p>
      {/* Rate limited: no relaunch offered; another sign-in right away would be refused too. */}
      {failed !== "rate_limited" && hubLaunchUrl() ? (
        <a className="w-fit rounded-lg border px-4 py-2" href={hubLaunchUrl()!}>
          {t("retry")}
        </a>
      ) : null}
    </div>
  );
};
