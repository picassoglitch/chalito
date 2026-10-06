import type { Policy } from "./policy/schema.js";

export interface PolicyRule {
  id: string;
  summary: string;
  effect: "allow" | "ask" | "deny";
}

const T = {
  es: {
    workspace: (l: string, p: string) => `Carpeta «${l}»: ${p}`,
    noWorkspaces: "Sin carpetas: no corre ninguna sesión",
    adapter: (n: string) => `Sesiones de ${n}`,
    maxMode: (m: string) => `Modo más permisivo que se puede pedir desde fuera: ${m}`,
    maxSandbox: (m: string) => `Sandbox de Codex más permisivo desde fuera: ${m}`,
    origin: {
      local: "Instrucciones locales",
      client: "Instrucciones desde tus dispositivos",
      mcp: "Instrucciones desde apps conectadas (MCP)",
      call: "Instrucciones por llamada",
    },
    ttl: (s: number) => `Las aprobaciones vencen a los ${Math.round(s / 60)} min y se niegan`,
    callLines: "Resumen de una línea en las llamadas (sin cifrar)",
    mcpCards: "Compartir tarjetas con apps conectadas (sin cifrar)",
    allowlist: (n: number) => `${n} comandos de prueba, lint o build sin preguntar`,
    domains: (n: number) => `${n} dominios web permitidos sin preguntar`,
  },
  en: {
    workspace: (l: string, p: string) => `Folder “${l}”: ${p}`,
    noWorkspaces: "No folders: no session runs",
    adapter: (n: string) => `${n} sessions`,
    maxMode: (m: string) => `Most permissive mode a remote surface can ask for: ${m}`,
    maxSandbox: (m: string) => `Most permissive Codex sandbox from a remote surface: ${m}`,
    origin: {
      local: "Local prompts",
      client: "Prompts from your devices",
      mcp: "Prompts from connected apps (MCP)",
      call: "Prompts by phone call",
    },
    ttl: (s: number) => `Approvals expire after ${Math.round(s / 60)} min and are denied`,
    callLines: "One-line summaries on calls (unencrypted)",
    mcpCards: "Share cards with connected apps (unencrypted)",
    allowlist: (n: number) => `${n} test, lint or build commands without asking`,
    domains: (n: number) => `${n} web domains allowed without asking`,
  },
} as const;

/** The signed policy in force, as the panel's Security tab lists it (localized, read-only). */
export const policyRules = (p: Policy, locale: "es" | "en"): PolicyRule[] => {
  const t = T[locale];
  const on = (b: boolean): PolicyRule["effect"] => (b ? "allow" : "deny");
  return [
    ...(p.workspaces.length
      ? p.workspaces.map((w) => ({
          id: `workspace:${w.label}`,
          summary: t.workspace(w.label, w.path),
          effect: "allow" as const,
        }))
      : [{ id: "workspaces", summary: t.noWorkspaces, effect: "deny" as const }]),
    { id: "adapters.claudeCode", summary: t.adapter("Claude Code"), effect: on(p.adapters.claudeCode) },
    { id: "adapters.codex", summary: t.adapter("Codex"), effect: on(p.adapters.codex) },
    { id: "adapters.grok", summary: t.adapter("Grok Build"), effect: on(p.adapters.grok ?? false) },
    { id: "adapters.gemini", summary: t.adapter("Gemini CLI"), effect: on(p.adapters.gemini ?? false) },
    ...(["local", "client", "mcp", "call"] as const).map((o) => ({
      id: `origins.${o}`,
      summary: t.origin[o],
      effect: on(p.origins[o]),
    })),
    { id: "remote.maxPermissionMode", summary: t.maxMode(p.remote.maxPermissionMode), effect: "ask" },
    { id: "remote.maxCodexSandbox", summary: t.maxSandbox(p.remote.maxCodexSandbox), effect: "ask" },
    { id: "approvals.ttl", summary: t.ttl(p.approvals.ttlSeconds), effect: "ask" },
    { id: "allowlist.commands", summary: t.allowlist(p.allowlist.commands.length), effect: "allow" },
    { id: "web.allowDomains", summary: t.domains(p.web.allowDomains.length), effect: "allow" },
    { id: "egress.callLines", summary: t.callLines, effect: on(p.egress.callLines) },
    { id: "egress.mcpCards", summary: t.mcpCards, effect: on(p.egress.mcpCards) },
  ];
};
