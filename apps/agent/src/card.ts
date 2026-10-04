import { CARD_MAX_TOKENS, estimateTokens, SessionCard, type AdapterKind, type SessionState } from "@chalito/protocol";
import { redact } from "./redact.js";

const clip = (s: string, n: number) => {
  const one = redact(s).replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};

/**
 * Session Card built deterministically from what the agent observed (no LLM).
 * Never carries file contents or diffs; free text is redacted and clipped so the card
 * stays under 300 tokens.
 */
export class CardBuilder {
  #version = 0;
  #goal = "";
  #lastAction: string | undefined;
  #openQuestion: string | undefined;
  #pending = new Set<string>();
  #files = new Set<string>();
  #state: SessionState = "starting";
  #blockers: string[] = [];

  constructor(
    private readonly base: { sid: string; adapter: AdapterKind; label: string; workspaceLabel: string },
    private readonly now: () => number,
  ) {}

  goal(prompt: string) {
    if (!this.#goal) this.#goal = clip(prompt, 200);
  }
  state(s: SessionState) {
    this.#state = s;
    if (s === "running") this.#openQuestion = undefined;
  }
  action(summary: string) {
    this.#lastAction = clip(summary, 140);
  }
  fileTouched(path: string) {
    this.#files.add(path);
  }
  question(q: string | undefined) {
    this.#openQuestion = q ? clip(q, 180) : undefined;
  }
  approvalPending(aid: string, on: boolean) {
    if (on) this.#pending.add(aid);
    else this.#pending.delete(aid);
  }
  blocker(text: string) {
    this.#blockers = [...this.#blockers, clip(text, 100)].slice(-3);
  }

  build(): SessionCard {
    const card = {
      v: 1 as const,
      ...this.base,
      cardVersion: ++this.#version,
      state: this.#state,
      goal: this.#goal,
      ...(this.#lastAction ? { lastAction: this.#lastAction } : {}),
      ...(this.#openQuestion ? { openQuestion: this.#openQuestion } : {}),
      pendingApprovals: this.#pending.size,
      filesTouched: this.#files.size,
      blockers: this.#blockers,
      updatedAt: this.now(),
    };
    // Shrink free text if a pathological mix still exceeds the budget.
    while (estimateTokens(card) > CARD_MAX_TOKENS && card.goal.length > 40)
      card.goal = `${card.goal.slice(0, card.goal.length - 40)}…`;
    return SessionCard.parse(card);
  }
}
