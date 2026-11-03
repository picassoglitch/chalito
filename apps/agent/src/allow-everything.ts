import type { Locale } from "@chalito/protocol";
import type { OsAuth } from "./devmode.js";
import type { Policy } from "./policy/schema.js";

// Owner 2026-11-02 — allow everything: the user is responsible. On by default; turning it back on
// is local only (OS auth + warning), like coordinator mode; remote surfaces can only turn it off.

/** Bumped when the warning changes; the audit records which version the person accepted. */
export const ALLOW_EVERYTHING_COPY_VERSION = 1;

export const ALLOW_EVERYTHING_WARNING: Record<Locale, string> = {
  es: "Chalito aprobará todas las acciones de todas las IA sin preguntarte. Tú eres responsable de lo que hagan.",
  en: "Chalito will approve every action from every AI without asking. You are responsible for what they do.",
};

export interface AllowEverythingPrompter {
  /** Shows the warning; true only on an explicit yes. */
  confirm(warning: string): Promise<boolean>;
}

export interface AllowEverythingDeps {
  policy: { get(): Policy; set(p: Policy, via: "local"): Promise<void> };
  osAuth: OsAuth;
  prompter: AllowEverythingPrompter;
  locale: Locale;
  emit: (type: string, meta: Record<string, unknown>) => Promise<void> | void;
}

export type AllowEverythingEnableResult =
  { ok: true } | { ok: false; reason: "os_auth_failed" | "cancelled" | "already_on" };

// Owner 2026-11-02 — on by default: only an explicit `enabled: false` turns it off.
export const allowEverythingOn = (p: Pick<Policy, "allowEverything">): boolean => p.allowEverything?.enabled !== false;

export const enableAllowEverything = async (d: AllowEverythingDeps): Promise<AllowEverythingEnableResult> => {
  if (allowEverythingOn(d.policy.get())) return { ok: false, reason: "already_on" };
  if (!(await d.osAuth.verify("Chalito: aprobar todo sin preguntar"))) return { ok: false, reason: "os_auth_failed" };
  if (!(await d.prompter.confirm(ALLOW_EVERYTHING_WARNING[d.locale]))) return { ok: false, reason: "cancelled" };
  await d.policy.set({ ...d.policy.get(), allowEverything: { enabled: true } }, "local");
  await d.emit("allow_everything.enabled", { copyVersion: ALLOW_EVERYTHING_COPY_VERSION, locale: d.locale });
  return { ok: true };
};

/** Always allowed, no OS prompt: turning it off can only make things safer. */
export const disableAllowEverything = async (
  d: Pick<AllowEverythingDeps, "policy" | "emit">,
  by: string,
): Promise<boolean> => {
  const cur = d.policy.get();
  if (!allowEverythingOn(cur)) return false;
  await d.policy.set({ ...cur, allowEverything: { enabled: false } }, "local");
  await d.emit("allow_everything.disabled", { by });
  return true;
};
