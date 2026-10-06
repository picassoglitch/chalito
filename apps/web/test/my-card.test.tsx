import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CustomCardSource, SignedCard } from "@chalito/scene/custom-card";
import type { AvatarApi } from "@/lib/avatar";
import { myCardSource } from "@/lib/my-card";

const ctx: { myCard: CustomCardSource | null } = { myCard: null };
vi.mock("@/components/ChalitoProvider", () => ({ useChalito: () => ctx }));
const { useMyCard } = await import("@/components/useMyCard");

const GCS = "https://storage.googleapis.com/b/avatars/o/a";
const card = (v: number): SignedCard => ({
  assetId: "0123456789abcdef0123456789abcdef",
  manifest: {
    width: 600,
    height: 800,
    emotions: { src: { neutral: "layer-neutral.webp" } },
    thumbs: { "128": "thumb-128.webp", "256": "thumb-256.webp" },
  },
  urls: {
    "layer-neutral.webp": `${GCS}/layer-neutral.webp?v=${v}`,
    "thumb-128.webp": `${GCS}/thumb-128.webp?v=${v}`,
    "thumb-256.webp": `${GCS}/thumb-256.webp?v=${v}`,
  },
  expiresAt: Date.now() + 3_600_000,
});

const source = (answer: () => SignedCard | null | "error") => {
  let calls = 0;
  const api = {
    companion: async () => (calls++, answer()),
  } as unknown as AvatarApi;
  return { src: myCardSource(api), calls: () => calls };
};

describe("useMyCard (the person's own companion card)", () => {
  it("draws the custom card; a broken drawing refreshes the URLs once, then falls back to the roster", async () => {
    let v = 0;
    const { src, calls } = source(() => card(++v));
    ctx.myCard = src;
    const { result } = renderHook(() => useMyCard());
    await waitFor(() => expect(result.current.card).not.toBeNull());
    expect(result.current.drawing).toBe(`${GCS}/layer-neutral.webp?v=1`);
    expect(result.current.thumb).toBe(`${GCS}/thumb-128.webp?v=1`);
    expect(result.current.files?.key).toMatch(/^custom:/);
    expect(result.current.wearing).toBe(true);

    act(() => result.current.onError());
    await waitFor(() => expect(result.current.drawing).toBe(`${GCS}/layer-neutral.webp?v=2`));
    expect(calls()).toBe(2);
    // Fails again right away: the roster avatar stands in, and the picker still knows it's custom.
    act(() => result.current.onError());
    expect(result.current.card).toBeNull();
    expect(result.current.files).toBeNull();
    expect(result.current.wearing).toBe(true);
    src.dispose();
  });

  it("no custom card, or the api down: the roster avatar", async () => {
    const none = source(() => null);
    ctx.myCard = none.src;
    const a = renderHook(() => useMyCard());
    await waitFor(() => expect(a.result.current.known).toBe(true));
    expect(a.result.current.card).toBeNull();
    expect(a.result.current.wearing).toBe(false);
    none.src.dispose();

    const down = source(() => "error");
    ctx.myCard = down.src;
    const b = renderHook(() => useMyCard());
    await waitFor(() => expect(b.result.current.known).toBe(true));
    expect(b.result.current.card).toBeNull();
    down.src.dispose();

    ctx.myCard = null; // signed out
    const c = renderHook(() => useMyCard());
    expect(c.result.current).toMatchObject({ card: null, known: false, wearing: false });
  });
});
