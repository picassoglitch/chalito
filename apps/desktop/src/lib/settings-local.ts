import { DEFAULT_SETTINGS, type SettingsValues } from "@chalito/ui";

const KEY = "chalito-desktop-settings";

/** Local copy of the settings (as the PWA keeps one); sync with the account is the panel's job. */
export const loadSettings = (storage: Pick<Storage, "getItem"> = localStorage): SettingsValues => {
  try {
    const raw = storage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<SettingsValues>) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
};

export const saveSettings = (v: SettingsValues, storage: Pick<Storage, "setItem"> = localStorage): void => {
  try {
    storage.setItem(KEY, JSON.stringify(v));
  } catch {
    // Storage full or blocked: the in-memory values still apply for this run.
  }
};
