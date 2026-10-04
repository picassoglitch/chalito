"use client";
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { hubLaunchUrl } from "@/lib/hub";
import { ackVia, notificationTarget } from "@/lib/notification-link";
import { useSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";
import { useChalito, useLive } from "./ChalitoProvider";

/**
 * /n/<nid>: the target of SMS/WhatsApp template buttons. Resolves the notification under RLS,
 * acks it (paired devices; the browser session alone can't ack), and redirects to its deepLink.
 * Signed out → the hub sign-in, coming back here.
 */
export const NotificationRedirect = ({ nid }: { nid: string }) => {
  const t = useTranslations("live.notification");
  const locale = useLocale() as "es" | "en";
  const session = useSession();
  const { status, client } = useChalito();
  const live = useLive();
  const [failed, setFailed] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    const go = (deepLink: string | null) => {
      const target = deepLink ? notificationTarget(deepLink, locale) : null;
      done.current = true;
      if (target) window.location.replace(target);
      else setFailed(true);
    };
    const signedOut = status === "signed_out" && session.status === "signed_out";
    if (signedOut) {
      const launch = hubLaunchUrl();
      done.current = true;
      if (launch) window.location.replace(`${launch}?next=${encodeURIComponent(`/n/${nid}`)}`);
      else setFailed(true);
      return;
    }
    if (status === "ready" && client) {
      if (live.status !== "live") return; // wait for the first sync
      const n = live.notifications.find((x) => x.nid === nid);
      if (!n) return go(null);
      const via = ackVia(document.referrer, new URL(window.location.href).searchParams.get("via"));
      void client.actions
        .ackNotification(nid, via === "app" ? "app" : via)
        .catch(() => undefined)
        .finally(() => go(n.deepLink));
      return;
    }
    if ((status === "unpaired" || status === "error") && session.status === "signed_in") {
      // Not paired: read it with the person's own session (RLS: member), no ack.
      void (async () => {
        const { data } = await (
          supabase() as unknown as {
            from(t: string): {
              select(c: string): {
                eq(c: string, v: string): { maybeSingle(): Promise<{ data: { deep_link?: string } | null }> };
              };
            };
          }
        )
          .from("notifications")
          .select("deep_link")
          .eq("nid", nid)
          .maybeSingle();
        go(data?.deep_link ?? null);
      })();
    }
  }, [status, client, live, session.status, nid, locale]);

  return failed ? <p role="alert">{t("notFound")}</p> : <p aria-live="polite">{t("opening")}</p>;
};
