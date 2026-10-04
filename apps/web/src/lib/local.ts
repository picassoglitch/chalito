"use client";
import { DEFAULT_SETTINGS, type SettingsValues } from "@chalito/ui";

/**
 * Local persistence for the shell slice. Settings and onboarding progress are kept on this
 * device until the Supabase settings rows land (a later slice); nothing here is secret.
 */
const SETTINGS_KEY = "chalito.settings.v1";
const ONBOARDED_KEY = "chalito.onboarded.v1";

const read = <T>(key: string): T | null => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const write = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / storage blocked: the UI still works for this visit */
  }
};

export const loadSettings = (): SettingsValues => ({
  ...DEFAULT_SETTINGS,
  ...(read<Partial<SettingsValues>>(SETTINGS_KEY) ?? {}),
});
export const saveSettings = (v: SettingsValues) => write(SETTINGS_KEY, v);
export const isOnboarded = (): boolean => read<boolean>(ONBOARDED_KEY) === true;
export const markOnboarded = () => write(ONBOARDED_KEY, true);
