import type { Participant, Speaker } from "./mesa.js";
import { isSpeaker } from "./mesa.js";

/**
 * The moderator picks who speaks (brief §5 M9): rules first, a cheap model second, and only the
 * addressed participants are called.
 *
 * Rules: @name / name: mentions; "@todos"/"@all"/"todos"/"everyone" for every AI participant.
 * Text that isn't the person's own (MCP, rooms) never fans out: it can reach the companion only,
 * so quoted text can't make Chalito spend on every brain.
 */
export interface CheapModerator {
  /** Pick from the candidates' pids; [] = nobody in particular. */
  pick(text: string, candidates: { pid: string; name: string }[]): Promise<string[]>;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

const ALL = /(^|[\s@])(todos|all|everyone|todas)\b/;

export const addressedByRules = (text: string, participants: Participant[]): Speaker[] => {
  const speakers = participants.filter(isSpeaker);
  const t = norm(text);
  if (ALL.test(t) && /@(todos|all|everyone|todas)\b|^(todos|everyone|all)[,:]/.test(t)) return speakers;
  return speakers.filter((p) => {
    const n = norm(p.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[\\s(])@${n}\\b`).test(t) || new RegExp(`^${n}\\s*[,:]`).test(t);
  });
};

export const moderate = async (p: {
  text: string;
  trusted: boolean;
  participants: Participant[];
  cheap?: CheapModerator;
}): Promise<Speaker[]> => {
  const speakers = p.participants.filter(isSpeaker);
  const companion = speakers.find((s) => s.kind === "companion");
  if (!p.trusted) return companion ? [companion] : [];
  const ruled = addressedByRules(p.text, p.participants);
  if (ruled.length > 0) return ruled;
  if (p.cheap) {
    const picked = await p.cheap
      .pick(
        p.text,
        speakers.map((s) => ({ pid: s.pid, name: s.name })),
      )
      .catch(() => [] as string[]);
    const chosen = speakers.filter((s) => picked.includes(s.pid)).slice(0, 2);
    if (chosen.length > 0) return chosen;
  }
  // Nobody named: the companion (the table's moderator) answers.
  return companion ? [companion] : speakers.slice(0, 1);
};
