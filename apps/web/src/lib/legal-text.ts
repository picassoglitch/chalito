import { parse } from "yaml";

/**
 * The public legal texts (packages/config/legal): privacy notice and terms, ES/EN, plus the
 * Developer-mode liability clause the terms must quote VERBATIM with its version (checklist 2.2).
 */
export type LegalDoc = "privacy" | "terms";

/** The clause's front matter and text, as `loadLiabilityText` (packages/config) reads it. */
export const parseLiability = (raw: string): { version: number; text: string } => {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error("devmode-liability: missing front matter");
  const meta = parse(m[1]!) as { version?: unknown };
  if (typeof meta.version !== "number") throw new Error("devmode-liability: no version");
  return { version: meta.version, text: m[2]!.trim() };
};

/** Fills the terms' clause placeholders; any other document passes through unchanged. */
export const fillLegal = (markdown: string, liability: { version: number; text: string }): string =>
  markdown
    .replaceAll("{devmodeVersion}", String(liability.version))
    // Quoted line by line, so a multi-paragraph clause stays inside the blockquote.
    .replaceAll(
      "> {devmodeText}",
      liability.text
        .split("\n")
        .map((l) => `> ${l}`.trimEnd())
        .join("\n"),
    );

/** Draft until the owner flips `reviewed: true` in legal.yaml (anything else counts as draft). */
export const isReviewed = (yaml: string): boolean => (parse(yaml) as { reviewed?: unknown } | null)?.reviewed === true;
