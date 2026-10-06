import type { Locale, Recipe } from "@chalito/protocol";
import type { OsAuth } from "../devmode.js";
import type { Policy } from "../policy/schema.js";
import type { AppCatalog } from "./catalog.js";

/**
 * Enabling a custom recipe ("Personalizada"). Like computer control (computer/toggle.ts), this
 * happens only on the device: `chalito apps custom enable <id>` in a terminal, or the desktop
 * panel through the agent's local IPC. OS authentication first, then the person reviews exactly
 * what the recipe runs and types its id. The enable lives in the signed policy with the file's
 * sha256, so editing the file turns it off until it's enabled again, a shell write can't flip it,
 * and no remote command can (packages/protocol/src/command.ts has none; `policy.tighten` can only
 * disable one).
 */

export interface CustomPrompter {
  /** Shows what the recipe runs (`summary`) and asks to continue. */
  review(summary: string[]): Promise<boolean>;
  /** The person types the recipe id. */
  typed(id: string): Promise<string>;
}

export const CUSTOM_COPY: Record<
  Locale,
  { title: (name: string) => string; warn: string; type: (id: string) => string }
> = {
  es: {
    title: (name) => `Activar la receta personalizada «${name}» en esta computadora`,
    warn: "Chalito ejecutará estos comandos cuando tú (o tus dispositivos de confianza) lo pidan. Actívala solo si la escribiste tú o confías en quien la escribió.",
    type: (id) => `Escribe «${id}» para activarla`,
  },
  en: {
    title: (name) => `Turn on the custom recipe “${name}” on this computer`,
    warn: "Chalito will run these commands when you (or your trusted devices) ask for them. Turn it on only if you wrote it or trust whoever did.",
    type: (id) => `Type “${id}” to turn it on`,
  },
};

/** Every command and address the recipe would use, for the review step (local only). */
export const recipeSummary = (r: Recipe): string[] => {
  const argv = (a?: string[]) => (a ? [a.join(" ")] : []);
  return [
    ...Object.entries(r.platforms).flatMap(([os, p]) => [
      ...(p?.install ? [`${os} install: ${p.install.via} ${p.install.cask ? "--cask " : ""}${p.install.ref}`] : []),
      ...(p?.launch?.command ? [`${os} launch: ${p.launch.command.join(" ")}`] : []),
      ...(p?.launch?.app ? [`${os} launch: ${p.launch.app}`] : []),
      ...(p?.detect.paths ?? []).map((x) => `${os} detect: ${x}`),
    ]),
    ...argv(r.signin.command).map((c) => `sign-in: ${c}`),
    ...argv(r.signin.statusCommand).map((c) => `status: ${c}`),
    ...argv(r.signin.logoutCommand).map((c) => `sign-out: ${c}`),
    ...(r.signin.url ? [`sign-in page: ${r.signin.url}`] : []),
    ...argv(r.driver.acp?.command).map((c) => `acp: ${c}`),
    ...argv(r.driver.terminal?.command).map((c) => `terminal: ${c}`),
    ...(r.driver.web ? [`web: ${r.driver.web.startUrl} (${r.driver.web.allowedOrigins.join(", ")})`] : []),
    ...(r.apiKey ? [`API key → $${r.apiKey.env}`] : []),
  ];
};

export interface CustomToggleDeps {
  policy: { get(): Policy; set(p: Policy, via: "local"): Promise<void> };
  catalog: Pick<AppCatalog, "custom">;
  osAuth: OsAuth;
  prompter: CustomPrompter;
  locale: Locale;
  emit: (type: string, meta: Record<string, unknown>) => Promise<void> | void;
}

export type CustomEnableResult =
  { ok: true } | { ok: false; reason: "unknown_recipe" | "already_on" | "os_auth_failed" | "cancelled" };

export const enableCustomRecipe = async (d: CustomToggleDeps, id: string): Promise<CustomEnableResult> => {
  const found = d.catalog.custom().recipes.find((r) => r.recipe.id === id);
  if (!found) return { ok: false, reason: "unknown_recipe" };
  const cur = d.policy.get().apps?.custom?.[id];
  if (cur?.enabled && cur.sha256 === found.sha256) return { ok: false, reason: "already_on" };
  if (!(await d.osAuth.verify("Chalito: activar una receta personalizada")))
    return { ok: false, reason: "os_auth_failed" };
  const copy = CUSTOM_COPY[d.locale];
  if (!(await d.prompter.review([copy.title(found.recipe.name), copy.warn, ...recipeSummary(found.recipe)])))
    return { ok: false, reason: "cancelled" };
  if ((await d.prompter.typed(copy.type(id))).trim() !== id) return { ok: false, reason: "cancelled" };
  // Re-read: the file must still be the one the person reviewed.
  const again = d.catalog.custom().recipes.find((r) => r.recipe.id === id);
  if (!again || again.sha256 !== found.sha256) return { ok: false, reason: "cancelled" };
  const p = d.policy.get();
  await d.policy.set(
    { ...p, apps: { ...p.apps, custom: { ...p.apps?.custom, [id]: { enabled: true, sha256: found.sha256 } } } },
    "local",
  );
  await d.emit("apps.custom_enabled", { appId: id });
  return { ok: true };
};

/** Always allowed locally, no OS prompt: turning one off can only make things safer. */
export const disableCustomRecipe = async (
  d: Pick<CustomToggleDeps, "policy" | "emit">,
  id: string,
  by: string,
): Promise<boolean> => {
  const p = d.policy.get();
  const cur = p.apps?.custom?.[id];
  if (!cur?.enabled) return false;
  await d.policy.set(
    { ...p, apps: { ...p.apps, custom: { ...p.apps?.custom, [id]: { ...cur, enabled: false } } } },
    "local",
  );
  await d.emit("apps.custom_disabled", { appId: id, by });
  return true;
};
