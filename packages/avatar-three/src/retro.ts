import { RETRO_HOLD_MS, holdPose, type Held } from "@chalito/avatar";
import type { AvatarFrame } from "./driver.js";

/** One retro step of a frame: the pose (body, bones, rig) held per `holdMs`; blinks, mouth and
 * expressions stay live so blinks and lip-sync don't lag (owner, 2026-10-25). */
export const stepFrame = (
  held: Held<AvatarFrame> | null,
  now: number,
  live: AvatarFrame,
  holdMs = RETRO_HOLD_MS,
): { held: Held<AvatarFrame>; frame: AvatarFrame } => {
  const h = holdPose(held, now, live, holdMs);
  if (h.value === live) return { held: h, frame: live };
  return {
    held: h,
    frame: {
      ...h.value,
      expressions: live.expressions,
      rig: { ...h.value.rig, lids: live.rig.lids, mouth: live.rig.mouth },
    },
  };
};

/** Keeps the held frame between calls: `step(now, driver.frame(now))` once per drawn frame. */
export class RetroStepper {
  #held: Held<AvatarFrame> | null = null;

  constructor(readonly holdMs = RETRO_HOLD_MS) {}

  step(now: number, live: AvatarFrame): AvatarFrame {
    const r = stepFrame(this.#held, now, live, this.holdMs);
    this.#held = r.held;
    return r.frame;
  }
}
