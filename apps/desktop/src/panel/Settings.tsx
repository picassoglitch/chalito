import { SettingsPanel, type PhoneVerifier, type SettingsValues } from "@chalito/ui";
import { useT } from "../lib/i18n.js";

/** The shared settings registry, desktop shell (the same rows as the PWA: parity test). */
export const Settings = ({
  values,
  onChange,
  hubPlansUrl,
  phoneVerifier,
}: {
  values: SettingsValues;
  onChange: (v: SettingsValues) => void;
  hubPlansUrl: string;
  phoneVerifier: PhoneVerifier;
}) => {
  const t = useT();
  return (
    <SettingsPanel
      shell="desktop"
      values={values}
      onChange={(k, v) => onChange({ ...values, [k]: v })}
      providerLabel={(p) => {
        const name = t(`integrations.${p}.name`);
        return name === `integrations.${p}.name` ? p : name;
      }}
      hubPlansUrl={hubPlansUrl}
      phoneVerifier={phoneVerifier}
    />
  );
};
