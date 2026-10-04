"use client";
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { safeOAuthRedirect, type ConsentRequest } from "@/lib/mcp";
import { signInAndReturn } from "@/lib/next-cookie";
import { useSession } from "@/lib/session";
import { useChalito } from "./ChalitoProvider";

/**
 * /oauth/consent?request=<id>: a connected app (Claude, ChatGPT) asks for access to the MCP gateway.
 * Shows who is asking and where the browser goes next; session:prompt is never pre-checked.
 * Approving needs this device's passkey; denying doesn't.
 */
export const OAuthConsent = () => {
  const t = useTranslations("mcp.consent");
  const locale = useLocale() as "es" | "en";
  const session = useSession();
  const { status, mcp, passkey, assertPasskey } = useChalito();
  const [req, setReq] = useState<ConsentRequest | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<"loading" | "ready" | "busy" | "missing" | "gone" | "error">("loading");
  const [note, setNote] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    const id = new URL(window.location.href).searchParams.get("request");
    if (!id) return void setState("missing");
    if (status === "signed_out" && session.status === "signed_out") {
      started.current = true;
      return signInAndReturn(window.location.pathname + window.location.search);
    }
    if (!mcp) return;
    started.current = true;
    void mcp.getRequest(id).then((r) => {
      if (typeof r === "string") return setState(r === "not_found" ? "gone" : "error");
      setReq(r);
      setChecked(Object.fromEntries(r.scopes.map((s) => [s.scope, s.defaultChecked])));
      setState("ready");
    });
  }, [status, session.status, mcp]);

  const go = (redirect: string) => {
    const u = safeOAuthRedirect(redirect);
    if (u) window.location.assign(u);
    else setNote(t("badRedirect"));
  };
  const approve = async () => {
    if (!req || !mcp || !assertPasskey) return;
    setState("busy");
    setNote(null);
    try {
      const assertion = await assertPasskey();
      const r = await mcp.approve(
        req.requestId,
        Object.keys(checked).filter((k) => checked[k]),
        assertion,
      );
      if (typeof r === "string") {
        setState("ready");
        return setNote(t(`error.${r}`));
      }
      go(r.redirect);
    } catch {
      setState("ready");
      setNote(t("error.passkey_failed"));
    }
  };
  const deny = async () => {
    if (!req || !mcp) return;
    setState("busy");
    const r = await mcp.deny(req.requestId);
    if (typeof r === "string") {
      setState("ready");
      return setNote(t(`error.${r}`));
    }
    go(r.redirect);
  };

  if (state === "missing" || state === "gone" || state === "error")
    return (
      <p role="alert" className="rounded-lg bg-red-50 p-4 text-red-900">
        {t(state)}
      </p>
    );
  if (!req) return <p aria-live="polite">{t("loading")}</p>;
  const selected = Object.values(checked).some(Boolean);
  const canApprove = status === "ready" && passkey.enrolled;
  return (
    <div className="grid gap-5" data-testid="consent">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold">{t("title", { client: req.client.name })}</h1>
        <p className="text-lg">
          {t("redirect")} <strong data-testid="redirect-host">{req.client.redirectHost}</strong>
        </p>
      </header>
      <fieldset className="grid gap-3 rounded-xl border bg-white p-4">
        <legend className="font-semibold">{t("scopes")}</legend>
        {req.scopes.map((s) => (
          <label
            key={s.scope}
            data-scope={s.scope}
            className={`flex items-start gap-2 ${s.scope === "session:prompt" ? "rounded-lg bg-amber-50 p-2" : ""}`}
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={!!checked[s.scope]}
              onChange={(e) => setChecked({ ...checked, [s.scope]: e.target.checked })}
            />
            <span>{s[locale]}</span>
          </label>
        ))}
      </fieldset>
      {status !== "ready" ? <p className="text-sm text-amber-900">{t("needsDevice")}</p> : null}
      {status === "ready" && !passkey.enrolled ? (
        <p data-testid="consent-needs-passkey" className="text-sm text-amber-900">
          {t("needsPasskey")}{" "}
          <Link href="/dispositivos" className="underline">
            {t("enrolPasskey")}
          </Link>
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
          disabled={state === "busy" || !selected || !canApprove}
          onClick={() => void approve()}
        >
          {t("approve")}
        </button>
        <button
          className="rounded-lg border px-4 py-2 disabled:opacity-50"
          disabled={state === "busy"}
          onClick={() => void deny()}
        >
          {t("deny")}
        </button>
      </div>
      {note ? (
        <p role="alert" className="text-sm text-red-800">
          {note}
        </p>
      ) : null}
    </div>
  );
};
