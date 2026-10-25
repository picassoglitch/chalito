import { loopbackUrl } from "./engine.js";

/** This computer's choice (the mic and the local engine are per device): never synced to the account. */
export interface OfflineVoiceSettings {
  enabled: boolean;
  /** A whisper.cpp server on this computer, until the app bundles one. */
  serverUrl: string;
  languages: string[];
  hotkey: string;
}

export const DEFAULT_OFFLINE_VOICE: OfflineVoiceSettings = {
  enabled: false,
  serverUrl: "http://127.0.0.1:8178",
  languages: ["es", "en"],
  hotkey: "CommandOrControl+Shift+Space",
};

const KEY = "chalito-desktop-offline-voice";
export const LANGUAGES = ["es", "en"] as const;

const MODIFIERS = new Set([
  "commandorcontrol",
  "cmdorctrl",
  "control",
  "ctrl",
  "alt",
  "option",
  "shift",
  "super",
  "command",
  "cmd",
]);
const KEY_RE =
  /^(?:[a-z]|[0-9]|f(?:[1-9]|1[0-2])|space|period|comma|slash|semicolon|quote|backquote|minus|equal|enter|tab)$/;

const CANON: Record<string, string> = {
  control: "ctrl",
  ctrl: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  super: "super",
  command: "super",
  cmd: "super",
};
/** Combos the OS or every app already uses; the native side refuses the same list (voice_hotkey.rs). */
const SYSTEM = new Set(
  "super+space ctrl+space alt+space alt+tab super+tab ctrl+tab alt+f4 super+q super+w super+l super+d super+h super+m ctrl+q ctrl+w ctrl+c ctrl+v ctrl+x ctrl+z ctrl+a ctrl+s super+c super+v super+x super+z super+a super+s".split(
    " ",
  ),
);

/** One or more modifiers and one key: a bare key would be taken from every other app. */
export const validHotkey = (s: string): boolean => {
  const parts = s.split("+").map((p) => p.trim().toLowerCase());
  const key = parts.pop() ?? "";
  if (!(parts.length > 0 && parts.every((p) => MODIFIERS.has(p)) && KEY_RE.test(key))) return false;
  // CommandOrControl is Super on macOS and Control elsewhere: refuse it if either is a system combo.
  const variants = ["ctrl", "super"].map((cmd) =>
    [...new Set(parts.map((p) => CANON[p] ?? cmd))].sort().concat(key).join("+"),
  );
  return !variants.some((v) => SYSTEM.has(v));
};

const clean = (v: Partial<OfflineVoiceSettings>): OfflineVoiceSettings => {
  const d = DEFAULT_OFFLINE_VOICE;
  const langs = Array.isArray(v.languages)
    ? v.languages.filter((l) => (LANGUAGES as readonly string[]).includes(l))
    : [];
  return {
    enabled: v.enabled === true,
    serverUrl: typeof v.serverUrl === "string" && loopbackUrl(v.serverUrl) ? v.serverUrl : d.serverUrl,
    languages: langs.length ? langs : d.languages,
    hotkey: typeof v.hotkey === "string" && validHotkey(v.hotkey) ? v.hotkey : d.hotkey,
  };
};

export const loadOfflineVoice = (storage: Pick<Storage, "getItem"> = localStorage): OfflineVoiceSettings => {
  try {
    const raw = storage.getItem(KEY);
    return raw ? clean(JSON.parse(raw) as Partial<OfflineVoiceSettings>) : DEFAULT_OFFLINE_VOICE;
  } catch {
    return DEFAULT_OFFLINE_VOICE;
  }
};

export const saveOfflineVoice = (v: OfflineVoiceSettings, storage: Pick<Storage, "setItem"> = localStorage): void => {
  try {
    storage.setItem(KEY, JSON.stringify(clean(v)));
  } catch {
    // Storage blocked: the in-memory choice still applies for this run.
  }
};
