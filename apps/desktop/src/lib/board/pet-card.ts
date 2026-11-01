import type { SkinId } from "@chalito/avatar-three";
import type { CardFiles } from "@chalito/scene/custom-card";
import type { DayPart } from "./backdrop.js";
import { convertCard, type CardManifest } from "./card.js";
import { decodeImage } from "./decode.js";
import type { CardSource } from "./link.js";
import type { Rgba } from "./pillow.js";
import { bakeSkin } from "./skin-bake.js";

type Decode = (url: string) => Promise<Rgba>;
type Bake = typeof bakeSkin;

/** How the board should look: the skin the pet wears and the sky for the person's local time. */
export interface BoardLook {
  skin?: SkinId | null;
  part: DayPart;
}

/** A skinned card has no rig on the desktop (avatar-three card.ts setSkin), so it doesn't blink on
 * the board either. */
const convert = (m: CardManifest, load: (f: string) => Promise<Rgba>, { skin, part }: BoardLook, bake: Bake) =>
  convertCard(skin ? { ...m, rig: undefined } : m, load, {
    backdrop: part,
    ...(skin ? { effect: (im: Rgba) => bake(im, skin, m.height / m.width) } : {}),
  });

const idOf = (card: string, { skin, part }: BoardLook) => `${card}|${part}${skin ? `|skin:${skin}` : ""}`;

/** A roster card served under `base` (the pet's ROSTER_BASE). */
export const rosterBoardCard = (
  base: string,
  avatar: string,
  look: BoardLook,
  decode: Decode = decodeImage,
  bake: Bake = bakeSkin,
): CardSource => ({
  id: idOf(`roster:${avatar}`, look),
  convert: async () => {
    const dir = `${base}assets/${avatar}/`;
    const manifest = (await (await fetch(`${dir}card.json`)).json()) as CardManifest;
    return convert(manifest, (f) => decode(dir + f), look, bake);
  },
});

/** The owner's custom card through its signed URLs; an expired one is refreshed and tried once more. */
export const customBoardCard = (
  files: CardFiles,
  look: BoardLook,
  decode: Decode = decodeImage,
  bake: Bake = bakeSkin,
): CardSource => ({
  id: idOf(files.key, look),
  convert: async () => {
    if (!files.manifest) throw new Error("custom card without its manifest");
    const load = async (f: string) => {
      const url = () => {
        const u = files.url(f);
        if (!u) throw new Error(`card file missing: ${f}`);
        return u;
      };
      try {
        return await decode(url());
      } catch (err) {
        if (!files.refresh) throw err;
        await files.refresh();
        return decode(url());
      }
    };
    return convert(files.manifest as CardManifest, load, look, bake);
  },
});
