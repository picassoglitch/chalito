/**
 * Brand lint (`pnpm lint:brand`). Fails on:
 *  - old names ("Director", "Chalyb Partner") anywhere user-facing;
 *  - provider names used as product/plan/cosmetic names, or in any user-facing message
 *    outside the allowlisted `integrations.*` key namespace (where describing an
 *    integration, e.g. "Conecta tu ChatGPT", is fine);
 *  - provider logo files among brand assets.
 */

export interface BrandIssue {
  file: string;
  where: string;
  message: string;
}

const OLD_NAMES = /\bDirector\b|\bChalyb Partner\b/;
const PROVIDER_NAMES = /\b(Claude|Anthropic|ChatGPT|OpenAI|Grok|xAI)\b/;
const LOGO_FILE = /(claude|anthropic|openai|chatgpt|grok|xai)/i;
export const INTEGRATION_NAMESPACE = "integrations.";

const flatten = (value: unknown, prefix = ""): [string, string][] => {
  if (typeof value === "string") return [[prefix, value]];
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      flatten(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [];
};

/** User-facing message catalogs (e.g. packages/ui/messages/es.json). */
export const lintMessages = (file: string, messages: unknown): BrandIssue[] => {
  const issues: BrandIssue[] = [];
  for (const [key, text] of flatten(messages)) {
    if (OLD_NAMES.test(text)) issues.push({ file, where: key, message: `old product name in "${text}"` });
    if (!key.startsWith(INTEGRATION_NAMESPACE) && PROVIDER_NAMES.test(text)) {
      issues.push({ file, where: key, message: `provider name outside ${INTEGRATION_NAMESPACE}* in "${text}"` });
    }
  }
  return issues;
};

/** Product, plan and cosmetic names: provider names are never allowed. */
export const lintNames = (file: string, names: Iterable<[where: string, name: string]>): BrandIssue[] => {
  const issues: BrandIssue[] = [];
  for (const [where, name] of names) {
    if (OLD_NAMES.test(name)) issues.push({ file, where, message: `old product name "${name}"` });
    if (PROVIDER_NAMES.test(name))
      issues.push({ file, where, message: `provider name in a product/plan/cosmetic name "${name}"` });
  }
  return issues;
};

export const lintAssetFiles = (files: Iterable<string>): BrandIssue[] =>
  [...files]
    .filter((f) => LOGO_FILE.test(f.split("/").pop() ?? ""))
    .map((f) => ({ file: f, where: "asset", message: "provider logo files may not be brand assets" }));
