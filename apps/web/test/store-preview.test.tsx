import { act, cleanup, render, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import es from "@chalito/ui/messages/es.json";
import type { SignedCard } from "@chalito/scene/custom-card";
import type { AvatarApi } from "@/lib/avatar";
import type { StoreApi } from "@/lib/store";
import { myCardSource } from "@/lib/my-card";
import { loadLastLook, ownLook, saveLastLook } from "@/lib/own-look";

/** /tienda's preview: from opening the page to settled, only the companion's own look is drawn. */
const GCS = "https://storage.googleapis.com/b/avatars/o/a";
const mine: SignedCard = {
  assetId: "0123456789abcdef0123456789abcdef",
  manifest: {
    width: 600,
    height: 800,
    emotions: { src: { neutral: "layer-neutral.webp" } },
    thumbs: { "128": "thumb-128.webp" },
  },
  urls: { "layer-neutral.webp": `${GCS}/layer-neutral.webp`, "thumb-128.webp": `${GCS}/thumb-128.webp` },
  expiresAt: Date.now() + 3_600_000,
};

let answer: (c: SignedCard | null) => void = () => undefined;
const avatar = {
  companion: () => new Promise<SignedCard | null>((r) => (answer = r)),
} as unknown as AvatarApi;
const store = { catalog: async () => [] } as unknown as StoreApi;
const ctx = {
  status: "ready",
  store,
  readCompanion: async () => ({ companionId: "chl_me", avatar: "luna", equipped: {} }),
  myCard: myCardSource(avatar),
  session: { status: "signed_in", session: { user: { id: "u1" } } },
};
vi.mock("@/components/ChalitoProvider", () => ({
  useChalito: () => ctx,
  ownerOf: (s: { user?: { id?: string } }) => s.user?.id ?? "",
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
const { Store } = await import("@/components/Store");

/** Every drawing the preview's body showed, in order (a MutationObserver sees each swap). */
const watchDrawings = () => {
  const seen: string[] = [];
  const note = () => {
    const src = document.querySelector('[data-testid="store-preview"] img')?.getAttribute("src");
    if (src && seen.at(-1) !== src) seen.push(src);
  };
  const obs = new MutationObserver(note);
  obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  return { seen, stop: () => obs.disconnect() };
};

describe("the store preview never shows the roster art and then the custom card", () => {
  beforeEach(() => {
    localStorage.clear();
    ctx.myCard = myCardSource(avatar);
    // The roster card.json for the preview's size and anchors.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ width: 600, height: 800, anchors: {} }))),
    );
  });
  afterEach(() => {
    cleanup();
    ctx.myCard.dispose();
    vi.unstubAllGlobals();
  });

  const open = () =>
    render(
      <NextIntlClientProvider locale="es" messages={es}>
        <Store />
      </NextIntlClientProvider>,
    );

  it("wears a custom card: the stand-in until the api answers, then only that card", async () => {
    const w = watchDrawings();
    open();
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(document.querySelector('[data-testid="store-preview"]')).toBeNull();
    await act(async () => answer(mine));
    await waitFor(() => expect(document.querySelector('[data-testid="store-preview"]')).toBeTruthy());
    w.stop();
    expect(w.seen).toEqual([`${GCS}/layer-neutral.webp`]);
    expect(loadLastLook("u1")).toEqual({ owner: "u1", kind: "custom" });
  });

  it("wears a roster avatar: one drawing, its own", async () => {
    const w = watchDrawings();
    open();
    await act(async () => answer(null));
    await waitFor(() => expect(document.querySelector('[data-testid="store-preview"]')).toBeTruthy());
    w.stop();
    expect(w.seen).toHaveLength(1);
    expect(w.seen[0]).toMatch(/^\/roster\/.*luna/);
    expect(loadLastLook("u1")).toEqual({ owner: "u1", kind: "roster" });
  });

  it("a returning roster look shows at once; a custom one waits; another account's is ignored", () => {
    expect(ownLook("unknown", null)).toBe("pending");
    expect(ownLook("unknown", { owner: "u1", kind: "roster" })).toBe("roster");
    expect(ownLook("unknown", { owner: "u1", kind: "custom" })).toBe("pending");
    expect(ownLook("none", null)).toBe("roster");
    saveLastLook({ owner: "u1", kind: "roster" });
    expect(loadLastLook("u2")).toBeNull();
    const blocked = () => {
      throw new Error("SecurityError");
    };
    expect(loadLastLook("u1", blocked)).toBeNull();
    expect(() => saveLastLook({ owner: "u1", kind: "custom" }, blocked)).not.toThrow();
  });
});
