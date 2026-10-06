import { isLegacyApp, type Locale } from "@chalito/protocol";
import type { OsAuth } from "../devmode.js";
import type { Policy } from "../policy/schema.js";
import type { AppCatalog } from "./catalog.js";
import { recipeSummary, type CustomPrompter } from "./custom-toggle.js";

/**
 * Letting an app start sessions on this computer (owner decision 2026-10-06). Every app beyond
 * what the signed policy already allows (the four former providers keep `policy.adapters`) is
 * OFF until the person turns it on HERE: `chalito apps sessions enable <id>` in a terminal, or
 * the desktop panel through the agent's local IPC. OS authentication first, then a review of what
 * the app runs and its id typed back, like a custom recipe. The switch lives in the signed policy
 * (`apps.sessions[id] === true`; missing = off), so a shell write can't flip it, `chalito policy
 * edit` refuses it, and no remote command can (`policy.tighten` can only turn one off).
 */

export const SESSIONS_COPY: Record<
  Locale,
  { title: (name: string) => string; warn: string; type: (id: string) => string }
> = {
  es: {
    title: (name) => `Permitir sesiones de «${name}» en esta computadora`,
    warn: "Tus dispositivos de confianza podrán iniciar sesiones de esta app aquí; cada acción sigue pidiendo tu aprobación. Esto ejecuta:",
    type: (id) => `Escribe «${id}» para permitirlo`,
  },
  en: {
    title: (name) => `Allow “${name}” sessions on this computer`,
    warn: "Your trusted devices will be able to start sessions of this app here; every action still asks for your approval. It runs:",
    type: (id) => `Type “${id}” to allow it`,
  },
};

export interface SessionsToggleDeps {
  policy: { get(): Policy; set(p: Policy, via: "local"): Promise<void> };
  catalog: Pick<AppCatalog, "get">;
  osAuth: OsAuth;
  prompter: CustomPrompter;
  locale: Locale;
  emit: (type: string, meta: Record<string, unknown>) => Promise<void> | void;
}

export type SessionsEnableResult =
  | { ok: true }
  | { ok: false; reason: "unknown_recipe" | "not_applicable" | "already_on" | "os_auth_failed" | "cancelled" };

/** Whether `apps.sessions` decides this app (not one of the four, which `policy.adapters` gates). */
export const sessionsApply = (appId: string): boolean => !isLegacyApp(appId);

/** What the review step shows for an app (its recipe's commands). Throws for an unknown app. */
export const sessionsChallenge = (catalog: Pick<AppCatalog, "get">, locale: Locale, appId: string) => {
  const e = catalog.get(appId);
  if (!e || (e.custom && !e.enabled) || !sessionsApply(appId)) return null;
  const copy = SESSIONS_COPY[locale];
  return {
    title: copy.title(e.recipe.name),
    warn: copy.warn,
    type: copy.type(appId),
    summary: recipeSummary(e.recipe),
  };
};

export const enableAppSessions = async (d: SessionsToggleDeps, id: string): Promise<SessionsEnableResult> => {
  if (!sessionsApply(id)) return { ok: false, reason: "not_applicable" };
  const e = d.catalog.get(id);
  // A custom recipe must be enabled on this computer first (its own local switch).
  if (!e || (e.custom && !e.enabled)) return { ok: false, reason: "unknown_recipe" };
  if (d.policy.get().apps?.sessions?.[id] === true) return { ok: false, reason: "already_on" };
  if (!(await d.osAuth.verify("Chalito: permitir sesiones de una app"))) return { ok: false, reason: "os_auth_failed" };
  const c = sessionsChallenge(d.catalog, d.locale, id)!;
  if (!(await d.prompter.review([c.title, c.warn, ...c.summary]))) return { ok: false, reason: "cancelled" };
  if ((await d.prompter.typed(c.type)).trim() !== id) return { ok: false, reason: "cancelled" };
  const p = d.policy.get();
  await d.policy.set({ ...p, apps: { ...p.apps, sessions: { ...p.apps?.sessions, [id]: true } } }, "local");
  await d.emit("apps.sessions_enabled", { appId: id });
  return { ok: true };
};

/** Always allowed locally, no OS prompt: turning one off can only make things safer. */
export const disableAppSessions = async (
  d: Pick<SessionsToggleDeps, "policy" | "emit">,
  id: string,
  by: string,
): Promise<boolean> => {
  const p = d.policy.get();
  if (p.apps?.sessions?.[id] !== true) return false;
  await d.policy.set({ ...p, apps: { ...p.apps, sessions: { ...p.apps?.sessions, [id]: false } } }, "local");
  await d.emit("apps.sessions_disabled", { appId: id, by });
  return true;
};
