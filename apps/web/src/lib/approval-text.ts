/**
 * What-you-see-is-what-you-sign for approval text (review R-M10, display side). Agent-written text
 * reaches this screen as data: invisible format characters (bidi overrides like U+202E, zero-width
 * joiners) can reorder or hide parts of a command, and the agent's summary cuts the tool input at
 * 300 characters. So: format and control characters are shown as visible markers (and flagged), and
 * a cut summary says so; approving then requires opening the full input.
 */

/** Unicode format (Cf) and control (Cc) characters, except tab and newline in multi-line input. */
const HIDDEN = /[\p{Cf}\p{Cc}]/gu;

export interface SafeText {
  text: string;
  /** Hidden characters were found (and are shown as markers). */
  hidden: boolean;
}

/** Each hidden character becomes a visible marker like ⟦U+202E⟧. */
export const revealHidden = (s: string, keepNewlines = false): SafeText => {
  let hidden = false;
  const text = s.replace(HIDDEN, (c) => {
    if (keepNewlines && (c === "\n" || c === "\t")) return c;
    hidden = true;
    return `⟦U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟧`;
  });
  return { text, hidden };
};

export interface ApprovalText {
  summary: SafeText;
  /** The summary doesn't show the whole input. */
  truncated: boolean;
  /** How many characters of the input the summary leaves out (when known). */
  hiddenChars: number | null;
  /** The full tool input, pretty-printed and revealed; null when the agent sent none. */
  full: SafeText | null;
}

const stringify = (v: unknown): string => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
};

export const approvalText = (d: {
  toolName?: string;
  summary?: string;
  input?: unknown;
  summaryTruncated?: boolean;
}): ApprovalText => {
  const summary = d.summary ?? "";
  const full = d.input === undefined ? null : stringify(d.input);
  // The agent builds `toolName: JSON(input).slice(0, 300)`: compare against the compact JSON.
  const compact = d.input === undefined ? null : typeof d.input === "string" ? d.input : JSON.stringify(d.input);
  const prefix =
    d.toolName && summary.startsWith(`${d.toolName}: `) ? `${d.toolName}: ` : /^[^:\s]{1,128}: /.exec(summary)?.[0];
  const shown = prefix ? summary.slice(prefix.length) : summary;
  const cut = compact !== null && compact.length > shown.length && compact.startsWith(shown);
  return {
    summary: revealHidden(summary),
    truncated: d.summaryTruncated === true || cut,
    hiddenChars: cut ? compact!.length - shown.length : null,
    full: full === null ? null : revealHidden(full, true),
  };
};
