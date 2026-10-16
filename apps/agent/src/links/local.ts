import type { AgentLink, Locale } from "@chalito/protocol";
import type { OsAuth } from "../devmode.js";
import type { LinkManager, LinkResultOf } from "./manager.js";

/**
 * Making a link on the device itself (ADR 0022 §3): the only way to make a hand-off link, since
 * it loosens policy (another agent can start work here), like Developer mode (ADR 0008). The CLI
 * (`chalito link add`) and the desktop panel both come through here: OS authentication first,
 * then one confirmation that restates what the link allows, then the typed phrase. Cancelling at
 * any step makes nothing.
 */
export interface LinkPrompter {
  /** "Let <sender> hand work to <receiver>?" with what it can and can't do. */
  confirm(summary: string[]): Promise<boolean>;
  typed(phrase: string): Promise<string>;
}

export const LINK_COPY_VERSION = 1;

export const LINK_COPY: Record<Locale, { handoff: string[]; share: string[]; phrase: string }> = {
  es: {
    handoff: [
      "Otro agente podrá pedirle trabajo a esta sesión (o abrir una nueva) en el espacio de trabajo del enlace.",
      "Cada herramienta riesgosa seguirá pidiendo tu aprobación; el Modo desarrollador nunca aprueba solo lo que venga de un enlace.",
      "Con «Preguntarme cada vez» (recomendado) confirmas cada encargo con un toque en tu teléfono.",
      "Puedes revocarlo desde cualquier dispositivo; «Cerrar sesión en todos» también lo revoca.",
    ],
    share: [
      "Otro agente podrá enviarle información a esta sesión. Llega como datos citados: nunca inicia ni dirige una tarea.",
      "Puedes revocarlo desde cualquier dispositivo.",
    ],
    phrase: "ENLAZAR AGENTES",
  },
  en: {
    handoff: [
      "Another agent will be able to ask this session (or a new one) for work in the link's workspace.",
      "Every risky tool still asks for your approval; Developer mode never auto-approves anything that comes over a link.",
      "With “Ask me each time” (recommended) you confirm each hand-off with one tap on your phone.",
      "You can revoke it from any device; “Sign out everywhere” revokes it too.",
    ],
    share: [
      "Another agent will be able to send this session information. It arrives as quoted data: it never starts or steers a task.",
      "You can revoke it from any device.",
    ],
    phrase: "LINK AGENTS",
  },
};

export const createLocalLink = async (d: {
  links: LinkManager;
  spec: Omit<AgentLink, "v" | "createdAt" | "createdBy">;
  osAuth: OsAuth;
  prompter: LinkPrompter;
  locale: Locale;
}): Promise<LinkResultOf<{ link: AgentLink }>> => {
  if (!(await d.osAuth.verify("Chalito: enlazar agentes"))) return { ok: false, reason: "os_auth_failed" };
  const copy = LINK_COPY[d.locale];
  if (!(await d.prompter.confirm(d.spec.mode === "handoff" ? copy.handoff : copy.share)))
    return { ok: false, reason: "cancelled" };
  if ((await d.prompter.typed(copy.phrase)).trim() !== copy.phrase) return { ok: false, reason: "cancelled" };
  return d.links.createLocal(d.spec);
};
