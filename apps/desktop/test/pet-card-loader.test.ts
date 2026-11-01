import { describe, expect, it } from "vitest";
import { PetCardLoader, RetryBackoff } from "../src/pet/card-loader.js";

describe("the custom pet image load", () => {
  it("retries the same custom character after a failed texture load", async () => {
    const loader = new PetCardLoader<string>();
    await expect(
      loader.load("custom:me", async () => {
        throw new Error("expired image");
      }),
    ).rejects.toThrow("expired image");
    expect(await loader.load("custom:me", async () => "my image")).toBe("my image");
    expect(await loader.load("custom:me", async () => "unneeded reload")).toBeNull();
  });
  it("does not let a slow old image replace the newly selected character", async () => {
    const loader = new PetCardLoader<string>();
    let finish!: (v: string) => void;
    const pending = loader.load(
      "old",
      () =>
        new Promise<string>((r) => {
          finish = r;
        }),
    );
    expect(await loader.load("custom:me", async () => "me")).toBe("me");
    finish("old");
    expect(await pending).toBeNull();
  });
  it("ignores an old failure without unlocking a newer successful image", async () => {
    const loader = new PetCardLoader<string>();
    let fail!: (e: Error) => void;
    const old = loader.load(
      "old",
      () =>
        new Promise<string>((_, reject) => {
          fail = reject;
        }),
    );
    expect(await loader.load("me", async () => "me")).toBe("me");
    fail(new Error("old image"));
    expect(await old).toBeNull();
    expect(await loader.load("me", async () => "reload")).toBeNull();
  });
  it("does not apply a load after the pet window closes", async () => {
    const loader = new PetCardLoader<string>();
    let finish!: (v: string) => void;
    const pending = loader.load(
      "custom:me",
      () =>
        new Promise<string>((r) => {
          finish = r;
        }),
    );
    loader.dispose();
    finish("me");
    expect(await pending).toBeNull();
  });
});

describe("retrying a pet look that keeps failing (#129)", () => {
  it("doubles from 3 s up to 5 min, and starts over for another look or after a success", () => {
    const b = new RetryBackoff();
    const delays = Array.from({ length: 10 }, () => b.next("me|"));
    expect(delays).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 96_000, 192_000, 300_000, 300_000, 300_000]);
    expect(b.next("luna|")).toBe(3_000);
    b.next("luna|");
    b.reset();
    expect(b.next("luna|")).toBe(3_000);
  });
});
