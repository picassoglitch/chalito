import { useSyncExternalStore } from "react";
import { useT } from "../lib/i18n.js";
import type { SignInController } from "../lib/sign-in.js";
import { GlyphView } from "./GlyphView.js";

const shortCode = (d: unknown): string | null =>
  typeof (d as { shortCode?: unknown } | null)?.shortCode === "string" ? (d as { shortCode: string }).shortCode : null;

/** Signed out: sign in with the hub (system browser), then get endorsed by a trusted client. */
export const SignIn = ({ controller }: { controller: SignInController | null }) => {
  const t = useT();
  const noop = () => () => undefined;
  const s = useSyncExternalStore(controller?.subscribe ?? noop, controller?.getSnapshot ?? (() => null));
  if (!controller || !s) return <p className="muted">{t("signIn.notConfigured")}</p>;
  const cancel = <button onClick={() => controller.cancel()}>{t("signIn.cancel")}</button>;
  switch (s.step) {
    case "signed_out":
      return (
        <div className="card" data-sign-in="signed_out">
          <p>{t("signIn.intro")}</p>
          <button onClick={() => void controller.start()}>{t("signIn.start")}</button>
        </div>
      );
    case "browser":
      return (
        <div className="card" data-sign-in="browser">
          <p>{t("signIn.browser")}</p>
          <div className="row">
            <button onClick={() => void controller.start()}>{t("signIn.reopen")}</button>
            {cancel}
          </div>
        </div>
      );
    case "exchanging":
      return <p className="muted">{t("signIn.exchanging")}</p>;
    case "endorsing": {
      const code = shortCode(s.display);
      return (
        <div className="card" data-sign-in="endorsing">
          <p>{t("signIn.endorsing")}</p>
          <div className="row">
            <GlyphView glyph={(s.display as { glyph?: unknown } | null)?.glyph} label={t("signIn.glyph")} />
            {code && <code className="fingerprint">{code}</code>}
          </div>
          {cancel}
        </div>
      );
    }
    case "ready":
      return (
        <div className="card" data-sign-in="ready">
          <p>{t("signIn.ready")}</p>
          {s.passkey !== "enrolled" && <p className="muted">{t("signIn.noPasskey")}</p>}
        </div>
      );
    case "error":
      return (
        <div className="card" data-sign-in="error">
          <p role="alert">{t(`signIn.errors.${s.reason}`)}</p>
          <button onClick={() => void controller.start()}>{t("signIn.retry")}</button>
        </div>
      );
  }
};
