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
const RANK: Record<CreatureAction, number> = { slump: 5, hop: 4, go: 3, glance: 2, perk: 1, wave: 0, cheer: 0, nod: 0 };

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
}

/** The one reaction an activity change calls for, or null (dropped, not queued). Attention moves never cut
 * an escalation's call; an alert adds nothing while an approval waits; a smaller move never cuts a bigger one. */
export const petReaction = ({ before, now, behaviour, quiet, playing }: ReactionInput): Reaction | null => {
  const muted = (a: ActivityAction) =>
    ATTENTION.has(a) && (quiet || CALLING.has(behaviour) || (a === "glance" && now.mode === "needs_you"));
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
