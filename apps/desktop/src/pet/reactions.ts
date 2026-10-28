import {
  activityActions,
  type Activity,
  type ActivityAction,
  type BehaviourState,
  type CreatureAction,
} from "@chalito/avatar";
import type { EmotionTag } from "@chalito/protocol";

/** One short reaction: the move and the face it wears for `faceMs`. */
export interface Reaction {
  action: ActivityAction;
  face: EmotionTag;
  faceMs: number;
}

const FACE: Record<ActivityAction, { face: EmotionTag; faceMs: number }> = {
  hop: { face: "happy", faceMs: 2500 },
  slump: { face: "sad", faceMs: 3500 },
  go: { face: "happy", faceMs: 1500 },
  glance: { face: "surprised", faceMs: 1500 },
  perk: { face: "surprised", faceMs: 1000 },
};

/** Which reaction wins when several land together, and which may cut which short. */
const RANK: Record<CreatureAction, number> = {
  slump: 5,
  hop: 4,
  go: 3,
  glance: 2,
  perk: 1,
  wave: 0,
  cheer: 0,
  nod: 0,
  walk: 0,
  notice: 0,
  poke: 0,
  spin: 0,
  giggle: 0,
  dizzy: 0,
};

/** Moves that only get attention: muted in Do Not Disturb and quiet hours, like the escalations. */
const ATTENTION = new Set<ActivityAction>(["go", "glance", "perk"]);

/** Escalation states that already call the person with their own move. */
const CALLING = new Set<BehaviourState>(["wave", "hop", "knock"]);

export interface ReactionInput {
  before: Activity | null;
  now: Activity;
  /** The behaviour machine's state this frame. */
  behaviour: BehaviourState;
  quiet: boolean;
  /** The action still playing, if any. */
  playing: CreatureAction | null;
  /** False when PerkGate turned this reply's perk down. */
  perkOk?: boolean;
}

/** The one reaction an activity change calls for, or null (dropped, not queued). Attention moves never cut
 * an escalation's call; an alert adds nothing while an approval waits; a smaller move never cuts a bigger one. */
export const petReaction = ({
  before,
  now,
  behaviour,
  quiet,
  playing,
  perkOk = true,
}: ReactionInput): Reaction | null => {
  const muted = (a: ActivityAction) =>
    (a === "perk" && !perkOk) ||
    (ATTENTION.has(a) && (quiet || CALLING.has(behaviour) || (a === "glance" && now.mode === "needs_you")));
  const action = activityActions(before, now).find((a) => !muted(a));
  if (!action || (playing && RANK[playing] > RANK[action])) return null;
  return { action, ...FACE[action] };
};

/** Plays a reaction. Face first: a happy face brings its own nod, which would replace the move. */
export const playReaction = (
  r: Reaction,
  now: number,
  flash: (face: EmotionTag, now: number, ms: number) => void,
  driver: { playAction(a: CreatureAction, now: number): void },
): void => {
  flash(r.face, now, r.faceMs);
  driver.playAction(r.action, now);
};

/** Replies come in bursts: with no reply for this long, the next one may perk. */
export const PERK_QUIET_MS = 60_000;

/** Perks at agent replies stay rare (owner, 2026-10-25): only the first reply after 60 s without any,
 * at most one per 60 s, and none while the panel is focused (the person is already reading). */
export class PerkGate {
  #lastReply = -Infinity;
  #lastPerk = -Infinity;

  /** A reply arrived at `now`; true = its perk may play (call `perked` if it does). */
  reply(now: number, panelFocused: boolean): boolean {
    const firstOfBurst = now - this.#lastReply >= PERK_QUIET_MS;
    this.#lastReply = now;
    return firstOfBurst && !panelFocused && now - this.#lastPerk >= PERK_QUIET_MS;
  }

  perked(now: number): void {
    this.#lastPerk = now;
  }
}

const MOUSE_ATTENTION = new Set<CreatureAction>(["walk", "notice"]);

/** Whether a mouse move (walk step, hover notice, poke) may play now: never over an escalation's call or a
 * bigger move; the walk and the notice are muted in DND and quiet hours like other attention moves. */
export const mouseMayPlay = (
  action: CreatureAction,
  s: { playing: CreatureAction | null; behaviour: BehaviourState; quiet: boolean },
): boolean =>
  !CALLING.has(s.behaviour) &&
  !(s.quiet && MOUSE_ATTENTION.has(action)) &&
  !(s.playing && RANK[s.playing] > RANK[action]);
