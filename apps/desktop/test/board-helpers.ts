import { createHash } from "node:crypto";
import { CARD_FRAMES, type BoardCard } from "../src/lib/board/card.js";
import { BoardLink, type BoardLinkOptions, type CardSource } from "../src/lib/board/link.js";
import { memoryPairStore } from "../src/lib/board/pairing.js";
import { FakeBoard, prePair } from "./fake-board.js";

export const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** A small card: the real background size, 10×10 sprites. */
export const testCard = (seed = 1): BoardCard => {
  const frames = Object.fromEntries(
    CARD_FRAMES.map((f, i) => [
      f,
      Uint8Array.from({ length: f === "background" ? 172 * 320 * 2 : 200 }, (_, j) => (j * 7 + i + seed) & 0xff),
    ]),
  ) as BoardCard["frames"];
  const key = createHash("sha256")
    .update(Buffer.concat(CARD_FRAMES.map((f) => frames[f])))
    .digest("hex");
  return { key, x: 81, y: 298, w: 10, h: 10, frames };
};

export const source = (card: BoardCard, id = card.key): CardSource & { calls: number } => {
  const s = { id, calls: 0, convert: async () => (s.calls++, card) };
  return s;
};

/** A board and its link; paired already unless said otherwise. The fake board confirms pairings as
 * fast as a test asks, so the human-speed floor is off unless a test sets minPairMs. */
export const setup = async ({ paired = true, ...opts }: BoardLinkOptions & { paired?: boolean } = {}) => {
  const board = new FakeBoard();
  const store = memoryPairStore();
  if (paired) await prePair(board, store);
  const link = new BoardLink(board, store, { replyMs: 300, minPairMs: 0, ...opts });
  link.start();
  return { board, link, store };
};
