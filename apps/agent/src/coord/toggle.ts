import { DEFAULT_AUTO_KINDS, type Locale } from "@chalito/protocol";
import type { OsAuth } from "../devmode.js";
import type { Policy } from "../policy/schema.js";

/**
 * Turning coordinator mode on or off on this computer (ADR 0025 §6). On is the ceiling for what
 * Chalito may answer for the owner on helper prompts here, so it is a loosening and happens only
 * on the device: `chalito coordinator enable` or the desktop panel through the local IPC, after OS
 * authentication and one confirmation that lists what Chalito answers and what still asks. No
 * remote command reaches it; remote surfaces can only turn it off (`policy.tighten`).
 */

export interface CoordinatorPrompter {
  /** "Let Chalito answer for you here?" with what it answers and what still asks. */
  confirm(answers: string[], asks: string[]): Promise<boolean>;
}

/** Bumped when the copy changes; the audit records which version the person accepted. */
export const COORDINATOR_COPY_VERSION = 1;

export const COORDINATOR_COPY: Record<Locale, { answers: string[]; asks: string[] }> = {
  es: {
    answers: [
      "Leer y buscar en tus proyectos",
      "Correr las pruebas, el lint y el build del proyecto",
      "Editar y crear archivos dentro del proyecto",
      "Git local: add, commit, ramas, merge, stash",
      "Instalar paquetes del proyecto (nunca globales)",
      "Subir las ramas del propio plan (coord/…)",
    ],
    asks: [
      "Borrar archivos o datos",
      "Subir a main o a cualquier otra rama",
      "Desplegar o escribir en servicios externos",
      "Cambios en bases de datos",
      "Cualquier cosa que cueste dinero",
      "Cualquier cosa fuera del proyecto",
    ],
  },
  en: {
    answers: [
      "Read and search your projects",
      "Run the project's tests, lint and build",
      "Edit and create files inside the project",
      "Local git: add, commit, branches, merge, stash",
      "Install the project's packages (never global)",
      "Push the plan's own branches (coord/…)",
    ],
    asks: [
      "Deleting files or data",
      "Pushing to main or any other branch",
      "Deploying or writing to outside services",
      "Database changes",
      "Anything that costs money",
      "Anything outside the project",
    ],
  },
};

export interface CoordinatorToggleDeps {
  policy: { get(): Policy; set(p: Policy, via: "local"): Promise<void> };
  osAuth: OsAuth;
  prompter: CoordinatorPrompter;
  locale: Locale;
  emit: (type: string, meta: Record<string, unknown>) => Promise<void> | void;
}

export type CoordinatorEnableResult =
  { ok: true } | { ok: false; reason: "os_auth_failed" | "cancelled" | "already_on" };

export const enableCoordinator = async (d: CoordinatorToggleDeps): Promise<CoordinatorEnableResult> => {
  if (d.policy.get().coordinator?.enabled) return { ok: false, reason: "already_on" };
  if (!(await d.osAuth.verify("Chalito: dejar que Chalito responda por ti en esta computadora")))
    return { ok: false, reason: "os_auth_failed" };
  const copy = COORDINATOR_COPY[d.locale];
  if (!(await d.prompter.confirm(copy.answers, copy.asks))) return { ok: false, reason: "cancelled" };
  const cur = d.policy.get();
  await d.policy.set({ ...cur, coordinator: { enabled: true, autoApprove: [...DEFAULT_AUTO_KINDS] } }, "local");
  await d.emit("coordinator.enabled", { copyVersion: COORDINATOR_COPY_VERSION, locale: d.locale });
  return { ok: true };
};

/** Always allowed locally, no OS prompt: turning it off can only make things safer. */
export const disableCoordinator = async (
  d: Pick<CoordinatorToggleDeps, "policy" | "emit">,
  by: string,
): Promise<boolean> => {
  const cur = d.policy.get();
  if (!cur.coordinator?.enabled) return false;
  await d.policy.set({ ...cur, coordinator: { ...cur.coordinator, enabled: false } }, "local");
  await d.emit("coordinator.disabled", { by });
  return true;
};

/** What this computer lets Chalito answer for the owner (empty when coordinator mode is off). */
export const coordinatorCeiling = (p: Policy) =>
  p.coordinator?.enabled ? (p.coordinator.autoApprove ?? DEFAULT_AUTO_KINDS) : [];
