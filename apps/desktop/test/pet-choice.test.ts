import { describe, expect, it } from "vitest";
import { cardFilesFrom } from "@chalito/scene/custom-card";
import { loadLastDrawn, petCard, saveLastDrawn, type LastDrawn, type PetCard } from "../src/pet/choice.js";

const mine = cardFilesFrom("asset_mine", { "card.json": "https://storage.googleapis.com/b/card.json" });
const drawn = (c: PetCard) => (c.kind === "wait" ? null : c.kind === "custom" ? c.files.key : c.avatar);

/** Every state the pet goes through from launch to settled, and the characters it drew on the way. */
const timeline = (steps: Parameters<typeof petCard>[0][]) =>
  [...new Set(steps.map(petCard).map(drawn))].filter((d): d is string => d !== null);

describe("the pet only ever draws the companion's own character", () => {
  it("waits on the placeholder until the custom card's answer, then draws that card (no roster on the way)", () => {
    const last: LastDrawn | null = null;
    expect(
      timeline([
        { avatar: "chalito", card: undefined, gaveUp: false, last },
        { avatar: "luna", card: undefined, gaveUp: false, last },
        { avatar: "luna", card: mine, gaveUp: false, last },
      ]),
    ).toEqual(["asset_mine"]);
  });

  it("draws the roster avatar once the api says there's no custom card", () => {
    expect(petCard({ avatar: "luna", card: undefined, gaveUp: false, last: null })).toEqual({ kind: "wait" });
    expect(petCard({ avatar: "luna", card: null, gaveUp: false, last: null })).toEqual({
      kind: "roster",
      avatar: "luna",
    });
  });

  it("a returning pet draws last time's roster avatar at once; last time's custom card waits for its URLs", () => {
    expect(
      petCard({ avatar: "luna", card: undefined, gaveUp: false, last: { kind: "roster", avatar: "luna" } }),
    ).toEqual({ kind: "roster", avatar: "luna" });
    // A different avatar than last time is not a returning look: wait for the answer.
    expect(
      petCard({ avatar: "bruno", card: undefined, gaveUp: false, last: { kind: "roster", avatar: "luna" } }),
    ).toEqual({ kind: "wait" });
    expect(petCard({ avatar: "luna", card: undefined, gaveUp: false, last: { kind: "custom" } })).toEqual({
      kind: "wait",
    });
  });

  it("without an answer it stops waiting after CARD_WAIT_MS and draws the roster avatar", () => {
    expect(petCard({ avatar: "luna", card: undefined, gaveUp: true, last: null })).toEqual({
      kind: "roster",
      avatar: "luna",
    });
  });

  it("keeps what it drew last in storage, and survives storage that throws", () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveLastDrawn({ kind: "roster", avatar: "luna" }, () => s);
    expect(loadLastDrawn(() => s)).toEqual({ kind: "roster", avatar: "luna" });
    m.set("chalito-desktop-pet-last", "{not json");
    expect(loadLastDrawn(() => s)).toBeNull();
    const blocked = () => {
      throw new Error("SecurityError");
    };
    expect(loadLastDrawn(blocked)).toBeNull();
    expect(() => saveLastDrawn({ kind: "custom" }, blocked)).not.toThrow();
  });
});
