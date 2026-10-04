/**
 * GO_LIVE 6.2: are the web app's production env vars on Vercel, and nothing that mustn't be?
 * Read-only: it parses `vercel env ls` output you pipe in; it never calls Vercel itself.
 *
 *   vercel env ls production --cwd apps/web | pnpm tsx scripts/vercel-env-check.ts
 *   pnpm tsx scripts/vercel-env-check.ts --file env-ls.txt
 *
 * Exit 0 when every required var is set for Production and no forbidden one is; 1 otherwise.
 * Values are never printed (`vercel env ls` shows them as "Encrypted" anyway).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface Expectation {
  name: string;
  why: string;
}

/** What apps/web reads in production (apps/web/src/lib/env.ts, apps/web/.env.example). */
export const REQUIRED: Expectation[] = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", why: "nexo-ai project URL" },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", why: "publishable key only" },
  { name: "NEXT_PUBLIC_CHALITO_API_BASE", why: "https://api.chalito.chalyb.com" },
  { name: "NEXT_PUBLIC_HUB_URL", why: "https://www.chalyb.com" },
  { name: "NEXT_PUBLIC_VAPID_PUBLIC_KEY", why: "the notifier's VAPID public key; Web Push opt-in" },
];
/** Set them unless the default is right. */
export const RECOMMENDED: Expectation[] = [
  { name: "NEXT_PUBLIC_CHALITO_ORCHESTRATOR_BASE", why: "the orchestrator's URL; falls back to the api base" },
];
/** Never on the web project: a dev-only switch, and server secrets a browser bundle could leak. */
export const FORBIDDEN: Expectation[] = [
  { name: "NEXT_PUBLIC_CHALITO_DEV_BACKEND", why: "in-browser fake backend; the production build refuses it" },
  { name: "SUPABASE_SECRET_KEY", why: "server secret; the web app never needs it" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", why: "bypasses RLS; never on the web project" },
  { name: "CHALITO_ADMIN_TOKEN", why: "the hub bearer; server only (Cloud Run)" },
  { name: "CHALITO_SSO_SECRET", why: "verifies launch tokens; api only" },
  { name: "VAPID_PRIVATE_KEY", why: "signs Web Push; the notifier only" },
];
/** A public var whose name says it's a secret. */
const SECRET_LOOKING = /^NEXT_PUBLIC_.*(SECRET|SERVICE_ROLE|PRIVATE|ADMIN_TOKEN)/;

export interface Row {
  name: string;
  environments: string;
}

/**
 * Rows of `vercel env ls`: a table whose columns are separated by 2+ spaces (name, value,
 * environments, created). Banner and header lines don't start with an UPPER_CASE name.
 */
export const parseEnvLs = (text: string): Row[] =>
  text
    .split("\n")
    .map((l) => l.trim().split(/\s{2,}/))
    .filter((cols) => /^[A-Z][A-Z0-9_]*$/.test(cols[0] ?? "") && cols.length >= 3)
    .map((cols) => ({ name: cols[0]!, environments: cols[2]! }));

export interface Report {
  ok: boolean;
  lines: string[];
}

export const check = (rows: Row[]): Report => {
  const prod = new Set(rows.filter((r) => /production/i.test(r.environments)).map((r) => r.name));
  const any = new Set(rows.map((r) => r.name));
  const lines: string[] = [];
  let ok = true;
  for (const e of REQUIRED) {
    const status = prod.has(e.name) ? "OK" : any.has(e.name) ? "MISSING (not in Production)" : "MISSING";
    if (status !== "OK") ok = false;
    lines.push(`${status.padEnd(28)} ${e.name}  (${e.why})`);
  }
  for (const e of RECOMMENDED)
    lines.push(`${(prod.has(e.name) ? "OK" : "WARN unset").padEnd(28)} ${e.name}  (${e.why})`);
  for (const e of FORBIDDEN)
    if (any.has(e.name)) {
      ok = false;
      lines.push(`${"FORBIDDEN".padEnd(28)} ${e.name}  (${e.why})`);
    }
  for (const name of any)
    if (SECRET_LOOKING.test(name) && !FORBIDDEN.some((e) => e.name === name)) {
      ok = false;
      lines.push(`${"FORBIDDEN".padEnd(28)} ${name}  (a public var named like a secret)`);
    }
  if (rows.length === 0) {
    ok = false;
    lines.push("no rows: is this `vercel env ls` output for the web project?");
  }
  return { ok, lines };
};

const main = () => {
  const i = process.argv.indexOf("--file");
  const text = i > 0 ? readFileSync(process.argv[i + 1]!, "utf8") : readFileSync(0, "utf8");
  const report = check(parseEnvLs(text));
  process.stdout.write(`${report.lines.join("\n")}\n${report.ok ? "PASS" : "FAIL"}\n`);
  process.exit(report.ok ? 0 : 1);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
