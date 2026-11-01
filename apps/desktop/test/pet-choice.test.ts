import { describe, expect, it } from "vitest";
import { cardFilesFrom } from "@chalito/scene/custom-card";
import { loadLastDrawn, petCard, saveLastDrawn, type PetCard } from "../src/pet/choice.js";

const mine = cardFilesFrom("asset_mine", { "card.json": "https://storage.googleapis.com/b/card.json" });
const drawn = (c: PetCard) => (c.kind === "wait" ? null : c.kind === "custom" ? c.files.key : c.avatar);

/** Every state the pet goes through from launch to settled, and the characters it drew on the way. */
const timeline = (steps: Parameters<typeof petCard>[0][]) =>
  [...new Set(steps.map(petCard).map(drawn))].filter((d): d is string => d !== null);

describe("the pet only ever draws the companion's own character", () => {
  it("does not draw a roster character while the custom card is unresolved", () => {
    expect(
      timeline([
        { avatar: "chalito", card: undefined },
        { avatar: "luna", card: undefined },
        { avatar: "luna", card: mine },
      ]),
    ).toEqual(["asset_mine"]);
  });

  it("draws the roster only when the account confirms there is no custom card", () => {
    expect(petCard({ avatar: "luna", card: undefined })).toEqual({ kind: "wait" });
    expect(petCard({ avatar: "luna", card: null })).toEqual({ kind: "roster", avatar: "luna" });
  });

  it("shows the same roster avatar it drew last while the account answers, never another one (#129)", () => {
    const luna = { kind: "roster", avatar: "luna" } as const;
    expect(petCard({ avatar: "luna", card: undefined, last: luna })).toEqual(luna);
    expect(petCard({ avatar: "luna", card: undefined, last: { kind: "roster", avatar: "calavera" } })).toEqual({
      kind: "wait",
    });
    expect(petCard({ avatar: "luna", card: undefined, last: { kind: "custom" } })).toEqual({ kind: "wait" });
    expect(petCard({ avatar: "luna", card: undefined, last: null })).toEqual({ kind: "wait" });
  });

  it("ignores what was saved before the fix (it may be the roster avatar that replaced a custom pet)", () => {
    const m = new Map([["chalito-desktop-pet-last", JSON.stringify({ kind: "roster", avatar: "calavera" })]]);
    expect(loadLastDrawn(() => ({ getItem: (k: string) => m.get(k) ?? null }))).toBeNull();
  });

  it("keeps what it drew last in storage, and survives storage that throws", () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveLastDrawn({ kind: "roster", avatar: "luna" }, () => s);
    expect(loadLastDrawn(() => s)).toEqual({ kind: "roster", avatar: "luna" });
    m.set("chalito-desktop-pet-last-v2", "{not json");
    expect(loadLastDrawn(() => s)).toBeNull();
    const blocked = () => {
      throw new Error("SecurityError");
    };
    expect(loadLastDrawn(blocked)).toBeNull();
    expect(() => saveLastDrawn({ kind: "custom" }, blocked)).not.toThrow();
  });
});
