import { useEffect, useSyncExternalStore } from "react";
import { SettingsPanel, type PhoneVerifier, type SettingContext, type SettingsValues } from "@chalito/ui";
import { useT } from "../lib/i18n.js";
import type { CustomCompanion, CustomCompanionView } from "../lib/custom-companion.js";

const noop = () => () => undefined;
const NONE: CustomCompanionView = { own: null, wearing: false, failed: false };
const none = () => NONE;

/** The shared settings registry, desktop shell (the same rows as the PWA: parity test). */
export const Settings = ({
  values,
  onChange,
  hubPlansUrl,
  phoneVerifier,
  custom = null,
}: {
  values: SettingsValues;
  onChange: SettingContext["set"];
  hubPlansUrl: string;
  phoneVerifier: PhoneVerifier;
  /** The person's own characters; null while signed out. */
  custom?: CustomCompanion | null;
}) => {
  const t = useT();
  const view = useSyncExternalStore(custom?.subscribe ?? noop, custom?.getSnapshot ?? none);
  // Each visit re-reads them: one may have been made in the PWA since.
  useEffect(() => void custom?.load(), [custom]);
  const set: SettingContext["set"] = (k, v) => {
    if (k === "avatar" && view.wearing) void custom?.backToRoster();
    onChange(k, v);
  };
  return (
    <SettingsPanel
      shell="desktop"
      values={values}
      onChange={set}
      providerLabel={(p) => {
        const name = t(`integrations.${p}.name`);
        return name === `integrations.${p}.name` ? p : name;
      }}
      hubPlansUrl={hubPlansUrl}
      phoneVerifier={phoneVerifier}
      customCompanion={view.wearing}
      {...(custom && view.own
        ? {
            customCharacter: { ...(view.own.thumb ? { thumb: view.own.thumb } : {}), onPick: () => void custom.wear() },
          }
        : {})}
      {...(view.failed ? { companionExtra: <p role="alert">{t("customCompanion.useFailed")}</p> } : {})}
    />
  );
};
