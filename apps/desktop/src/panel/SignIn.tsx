import { useSyncExternalStore } from "react";
import { useT } from "../lib/i18n.js";
import type { SessionSetup } from "./use-account-session.js";

/** Signed out: sign in with the hub (system browser); that sign-in enrols this computer. */
export const SignIn = ({ setup }: { setup: SessionSetup }) => {
  const t = useT();
  const controller = setup.state === "ready" ? setup.controller : null;
  const noop = () => () => undefined;
  const s = useSyncExternalStore(controller?.subscribe ?? noop, controller?.getSnapshot ?? (() => null));
  if (setup.state === "starting") return <p className="muted">{t("signIn.starting")}</p>;
  if (setup.state === "ready" && setup.restoring) return <p className="muted">{t("signIn.restoring")}</p>;
  if (setup.state === "failed")
    return (
      <p role="alert" data-sign-in="setup_failed">
        {t("signIn.setupFailed", { detail: setup.detail })}
      </p>
    );
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
          {s.stale && <p role="status">{t("signIn.staleLink")}</p>}
          <div className="row">
            <button onClick={() => void controller.start()}>{t("signIn.reopen")}</button>
            {cancel}
          </div>
        </div>
      );
    case "exchanging":
      return <p className="muted">{t("signIn.exchanging")}</p>;
    case "enrolling":
      return (
        <p className="muted" data-sign-in="enrolling">
          {t("signIn.enrolling")}
        </p>
      );
    case "ready":
      return (
        <div className="card" data-sign-in="ready">
          <p>{t("signIn.ready")}</p>
          {s.passkey !== "enrolled" && <p className="muted">{t("signIn.noPasskey")}</p>}
          <p className="muted">{t("signIn.petHint")}</p>
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
