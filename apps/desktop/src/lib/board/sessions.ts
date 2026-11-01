import type { Snapshot } from "@chalito/client";
import type { OwnSessionView } from "../ipc.js";

// Owner, 2026-10-30: with nothing to approve, the board's double-click screen lists every active
// session (BOARD_LINK `sessions`). Names and short titles only: never paths, ids or content.

export type BoardSessionState = "working" | "waiting" | "idle";

export interface BoardSession {
  agent: string;
  computer: string;
  title: string;
  state: BoardSessionState;
  /** Epoch ms the session entered this state. */
  since: number;
}

export interface BoardSessions {
  items: BoardSession[];
  /** Active sessions left out to keep the line within the protocol's limits. */
  more: number;
}

/** BOARD_LINK limits, in UTF-16 units, and the most items the board keeps. */
export const SESSION_LIMITS = { agent: 16, computer: 16, title: 24 } as const;
export const MAX_SESSION_ITEMS = 24;
const MAX_LINE_BYTES = 4096;

const LIVE_STATE: Record<string, BoardSessionState> = {
  starting: "working",
  running: "working",
  waiting_approval: "waiting",
  waiting_input: "waiting",
  idle: "idle",
};
const OWN_STATE: Partial<Record<OwnSessionView["state"], BoardSessionState>> = {
  working: "working",
  question: "waiting",
  approval: "waiting",
};
const ORDER: Record<BoardSessionState, number> = { waiting: 0, working: 1, idle: 2 };

/** Cut to max UTF-16 units with "…", never splitting a surrogate pair. */
export const clip = (s: unknown, max: number): string => {
  // Agent-written fields aren't validated: anything but a string is dropped, and so are lone surrogates.
  if (typeof s !== "string") return "";
  const flat = s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
};

const folderName = (cwd: string | null): string | null => cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null;

/** When each live session entered its current state. A row's updatedAt moves on any write (its card
 * too), so it can't say how long a session has been working; first sight falls back to it. */
export class StateSince {
  #seen = new Map<string, { state: string; at: number }>();

  at(sid: string, state: string, fallback: number, now = Date.now()): number {
    const known = this.#seen.get(sid);
    if (known?.state === state) return known.at;
    const at = known ? now : fallback;
    this.#seen.set(sid, { state, at });
    return at;
  }
}

const item = (agent: unknown, computer: unknown, title: unknown, state: BoardSessionState, since: number) => ({
  agent: clip(agent, SESSION_LIMITS.agent) || "agente",
  computer: clip(computer, SESSION_LIMITS.computer),
  title: clip(title, SESSION_LIMITS.title),
  state,
  since: Number.isFinite(since) && since > 0 ? Math.round(since) : 0,
});

const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).length;

/** The `sessions` message: active sessions here and on the person's other computers, waiting ones
 * first, as many as fit in one line (the rest counted in `more`). */
export const boardSessions = (
  live: Pick<Snapshot, "sessions" | "devices">,
  own: readonly OwnSessionView[],
  here = "Esta compu",
  since = new StateSince(),
): BoardSessions => {
  const names = new Map(live.devices.map((d) => [d.deviceId, d.name]));
  const all: BoardSession[] = [];
  for (const s of live.sessions) {
    const state = LIVE_STATE[s.state ?? ""];
    if (state)
      all.push(
        item(
          s.appId ?? s.adapter,
          names.get(s.agentDeviceId),
          s.label,
          state,
          since.at(s.sid, s.state ?? "", s.updatedAt),
        ),
      );
  }
  for (const v of own) {
    const state = OWN_STATE[v.state];
    const title = v.title ?? folderName(v.cwd) ?? "";
    if (state) all.push(item(v.source === "claude" ? "claude-code" : "codex", here, title, state, v.since));
  }
  all.sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.since - a.since);
  const items = all.slice(0, MAX_SESSION_ITEMS);
  while (items.length && bytes({ v: 1, type: "sessions", items, more: all.length - items.length }) >= MAX_LINE_BYTES)
    items.pop();
  return { items, more: all.length - items.length };
};
