import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import es from "@chalito/ui/messages/es.json";
import en from "@chalito/ui/messages/en.json";
import {
  attestationOk,
  checkPhoto,
  httpAvatar,
  newCreationId,
  parseCreation,
  type AvatarApi,
  type Creation,
} from "@/lib/avatar";

const ADULT = { ownPhoto: true, ageBand: "18_plus", guardianConsent: false } as const;

const GCS = "https://storage.googleapis.com/b/avatars/o/a";
const CARD = {
  manifest: {
    emotions: {
      mode: "swap",
      src: {
        neutral: "layer-neutral.webp",
        happy: "layer-happy.webp",
        sad: "layer-sad.webp",
        surprised: "layer-surprised.webp",
        tired: "layer-tired.webp",
      },
    },
    thumbs: { "128": "thumb-128.webp" },
  },
  urls: Object.fromEntries(
    ["layer-neutral", "layer-happy", "layer-sad", "layer-surprised", "layer-tired", "thumb-128"].map((f) => [
      `${f}.webp`,
      `${GCS}/${f}.webp?X-Goog-Signature=x`,
    ]),
  ),
};
const DONE = { creationId: "cr_0123456789abcdef", status: "succeeded", free: true, priceTokens: 0, card: CARD };

describe("custom companion client (/v1/avatar)", () => {
  it("checks the photo before uploading: PNG/JPEG/WebP up to 10 MB", () => {
    expect(checkPhoto({ type: "image/jpeg", size: 2_000_000 })).toBe("ok");
    expect(checkPhoto({ type: "image/gif", size: 10 })).toBe("type");
    expect(checkPhoto({ type: "image/svg+xml", size: 10 })).toBe("type");
    expect(checkPhoto({ type: "image/png", size: 10 * 1024 * 1024 + 1 })).toBe("size");
    expect(newCreationId()).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("parses a finished card strictly: signed bucket URLs only, every drawing present", () => {
    expect(parseCreation(DONE)?.card?.emotions.happy).toBe("layer-happy.webp");
    expect(
      parseCreation({
        ...DONE,
        card: { ...CARD, urls: { ...CARD.urls, "layer-happy.webp": "https://evil.example/x" } },
      }),
    ).toBeNull();
    const { "layer-sad.webp": _gone, ...missing } = CARD.urls;
    expect(parseCreation({ ...DONE, card: { ...CARD, urls: missing } })).toBeNull();
    expect(parseCreation({ ...DONE, status: "dancing" })).toBeNull();
    expect(
      parseCreation({ creationId: "x", status: "failed", free: false, priceTokens: 5, failure: "refused" }),
    ).toEqual({
      creationId: "x",
      status: "failed",
      free: false,
      priceTokens: 5,
      failure: "refused",
    });
  });

  it("start: the signed PUT on success; no_tokens with its chip; busy; daily limit; retry on 5xx", async () => {
    const answer = (status: number, body: unknown) =>
      httpAvatar(
        "https://api.test",
        async () => "tok",
        (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
      );
    const ok = await answer(201, {
      creationId: "cr_0123456789abcdef",
      status: "awaiting_upload",
      free: true,
      priceTokens: 0,
      upload: {
        url: `${GCS}?X-Goog-Signature=put`,
        headers: { "content-type": "image/jpeg", "x-goog-content-length-range": "0,10485760" },
      },
    }).start("cr_0123456789abcdef", "image/jpeg", ADULT);
    expect(ok).toMatchObject({
      ok: true,
      upload: { url: expect.stringMatching(/^https:\/\/storage\.googleapis\.com\//) },
    });
    expect(
      await answer(402, { error: "no_tokens", chips: [{ href: "/creditos" }] }).start("x", "image/png", ADULT),
    ).toEqual({
      ok: false,
      reason: "no_tokens",
      chipHref: "/creditos",
    });
    expect(await answer(409, { error: "busy" }).start("x", "image/png", ADULT)).toEqual({ ok: false, reason: "busy" });
    expect(await answer(429, { error: "daily_limit" }).start("x", "image/png", ADULT)).toEqual({
      ok: false,
      reason: "daily_limit",
    });
    expect(await answer(503, {}).start("x", "image/png", ADULT)).toEqual({ ok: false, reason: "retry" });
    // An upload target off the bucket is refused.
    expect(
      await answer(201, {
        ...DONE,
        status: "awaiting_upload",
        card: undefined,
        upload: { url: "https://evil.example/u", headers: {} },
      }).start("x", "image/png", ADULT),
    ).toEqual({ ok: false, reason: "failed" });
  });

  it("start sends the attestation (guardian only at 13–17) and useWhenReady; maps the refusals", async () => {
    const sent: unknown[] = [];
    const api = (status: number, body: unknown) =>
      httpAvatar("https://api.test", async () => "tok", (async (_u: string, init: RequestInit) => {
        sent.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch);
    await api(503, {}).start("x", "image/png", ADULT, { useWhenReady: true });
    await api(503, {}).start("x", "image/png", { ownPhoto: true, ageBand: "13_17", guardianConsent: true });
    expect(sent).toEqual([
      {
        creationId: "x",
        contentType: "image/png",
        attestation: { ownPhoto: true, ageBand: "18_plus" },
        useWhenReady: true,
      },
      {
        creationId: "x",
        contentType: "image/png",
        attestation: { ownPhoto: true, ageBand: "13_17", guardianConsent: true },
      },
    ]);
    expect(await api(403, { error: "age_refused" }).start("x", "image/png", ADULT)).toEqual({
      ok: false,
      reason: "age_refused",
    });
    expect(await api(403, { error: "guardian_required" }).start("x", "image/png", ADULT)).toEqual({
      ok: false,
      reason: "guardian_required",
    });
    expect(await api(400, { error: "attestation_required" }).start("x", "image/png", ADULT)).toEqual({
      ok: false,
      reason: "attestation_required",
    });
  });

  it("consent: own photo and 18+, or 13–17 with a guardian; never under 13", () => {
    expect(attestationOk(ADULT)).toBe(true);
    expect(attestationOk({ ...ADULT, ownPhoto: false })).toBe(false);
    expect(attestationOk({ ...ADULT, ageBand: null })).toBe(false);
    expect(attestationOk({ ownPhoto: true, ageBand: "13_17", guardianConsent: false })).toBe(false);
    expect(attestationOk({ ownPhoto: true, ageBand: "13_17", guardianConsent: true })).toBe(true);
    expect(attestationOk({ ownPhoto: true, ageBand: "under_13", guardianConsent: true })).toBe(false);
  });

  it("uploads the photo with exactly the signed headers", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const api = httpAvatar("https://api.test", async () => "tok", (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch);
    const headers = { "content-type": "image/jpeg", "x-goog-content-length-range": "0,10485760" };
    expect(await api.upload({ url: `${GCS}?sig`, headers }, new Blob(["x"], { type: "image/jpeg" }))).toBe(true);
    expect(seen[0]).toMatchObject({ url: `${GCS}?sig`, init: { method: "PUT", headers } });
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("es and en carry the same createCharacter strings", () => {
    const keys = (o: unknown, p = ""): string[] =>
      typeof o === "object" && o ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p];
    expect(keys(en.createCharacter).sort()).toEqual(keys(es.createCharacter).sort());
  });
});

// ---- the component ------------------------------------------------------------------------------
const ctx: { avatar: AvatarApi | null } = { avatar: null };
vi.mock("@/components/ChalitoProvider", () => ({ useChalito: () => ctx }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
const { CreateCharacter } = await import("@/components/CreateCharacter");

const fakeApi = (o: { free: boolean; startReason?: "no_tokens" }) => {
  const calls: string[] = [];
  const starts: unknown[][] = [];
  let polls = 0;
  const api: AvatarApi = {
    quote: async () => ({ free: o.free, priceTokens: 217_750, dailyLeft: 5, active: null }),
    start: async (id, ...rest) => {
      calls.push(`start:${id}`);
      starts.push(rest);
      if (o.startReason) return { ok: false, reason: o.startReason, chipHref: "/creditos" };
      return {
        ok: true,
        creation: { creationId: id, status: "awaiting_upload", free: o.free, priceTokens: o.free ? 0 : 217_750 },
        upload: { url: `${GCS}?sig`, headers: {} },
      };
    },
    upload: async () => (calls.push("upload"), true),
    uploaded: async (id) => (
      calls.push("uploaded"),
      { creationId: id, status: "queued", free: o.free, priceTokens: 0 }
    ),
    status: async (id) => {
      calls.push("status");
      return ++polls < 2
        ? { creationId: id, status: "generating", free: o.free, priceTokens: 0 }
        : (parseCreation({ ...DONE, creationId: id }) as Creation);
    },
    use: async (id) => (calls.push(`use:${id}`), "ok"),
  };
  return { api, calls, starts };
};

const renderIt = (props: Parameters<typeof CreateCharacter>[0] = {}) =>
  render(
    <NextIntlClientProvider locale="es" messages={es}>
      <CreateCharacter {...props} />
    </NextIntlClientProvider>,
  );

const pickPhoto = async () =>
  fireEvent.change(await screen.findByTestId("create-character-file"), {
    target: { files: [new File(["jpeg"], "me.jpg", { type: "image/jpeg" })] },
  });
const consentAdult = () => {
  fireEvent.click(screen.getByTestId("create-character-own-photo"));
  fireEvent.click(screen.getByTestId("create-character-age-18_plus"));
};
const goDisabled = () => (screen.getByTestId("create-character-go") as HTMLButtonElement).disabled;

describe("Crea tu personaje", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows 'Gratis la primera vez', then the price in tokens", async () => {
    ctx.avatar = fakeApi({ free: true }).api;
    renderIt();
    expect(await screen.findByText("Gratis la primera vez")).toBeTruthy();
    cleanup();
    ctx.avatar = fakeApi({ free: false }).api;
    renderIt();
    expect((await screen.findByTestId("create-character-price")).textContent).toMatch(/217.750 tokens/);
  });

  it("refuses a non-photo before uploading anything", async () => {
    const { api, calls } = fakeApi({ free: true });
    ctx.avatar = api;
    renderIt();
    const input = await screen.findByTestId("create-character-file");
    fireEvent.change(input, { target: { files: [new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })] } });
    expect(screen.getByTestId("create-character-note").textContent).toContain("PNG, JPEG o WebP");
    expect((screen.getByTestId("create-character-go") as HTMLButtonElement).disabled).toBe(true);
    expect(calls).toEqual([]);
  });

  it("photo → preview → upload → progress → the five drawings → set as companion", async () => {
    const { api, calls } = fakeApi({ free: true });
    ctx.avatar = api;
    renderIt();
    const input = await screen.findByTestId("create-character-file");
    fireEvent.change(input, { target: { files: [new File(["jpeg"], "me.jpg", { type: "image/jpeg" })] } });
    expect((await screen.findByTestId("create-character-preview")).getAttribute("src")).toBe("blob:preview");
    expect(goDisabled()).toBe(true); // not without the consent
    consentAdult();
    fireEvent.click(screen.getByTestId("create-character-go"));
    expect((await screen.findByTestId("create-character-status")).textContent).toMatch(/fila|Dibujando/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    const result = await screen.findByTestId("create-character-result");
    expect(result.querySelectorAll("img")).toHaveLength(5);
    fireEvent.click(screen.getByTestId("create-character-use"));
    await waitFor(() => expect(screen.getByTestId("create-character-used")).toBeTruthy());
    const id = calls[0]!.slice("start:".length);
    expect(calls.filter((c) => !c.startsWith("status"))).toEqual([`start:${id}`, "upload", "uploaded", `use:${id}`]);
  });

  it("not enough tokens: an inline chip to /creditos, nothing uploaded", async () => {
    const { api, calls } = fakeApi({ free: false, startReason: "no_tokens" });
    ctx.avatar = api;
    renderIt();
    await pickPhoto();
    consentAdult();
    fireEvent.click(screen.getByTestId("create-character-go"));
    const note = await screen.findByTestId("create-character-note");
    expect(note.textContent).toContain("No te alcanzan los tokens");
    expect(note.querySelector("a")?.getAttribute("href")).toBe("/creditos");
    expect(calls).not.toContain("upload");
  });

  it("under 13: a clear refusal and no way to create, even with a guardian", async () => {
    const { api, calls } = fakeApi({ free: true });
    ctx.avatar = api;
    renderIt();
    await pickPhoto();
    fireEvent.click(screen.getByTestId("create-character-own-photo"));
    fireEvent.click(screen.getByTestId("create-character-age-under_13"));
    expect(screen.getByTestId("create-character-under13").textContent).toContain("al menos 13 años");
    expect(screen.queryByTestId("create-character-guardian")).toBeNull();
    expect(goDisabled()).toBe(true);
    fireEvent.click(screen.getByTestId("create-character-go"));
    expect(calls).toEqual([]);
  });

  it("13–17: needs 'Tengo permiso de mi mamá, papá o tutor'; the photo must be theirs", async () => {
    const { api, starts } = fakeApi({ free: true });
    ctx.avatar = api;
    renderIt();
    await pickPhoto();
    fireEvent.click(screen.getByTestId("create-character-age-13_17"));
    const guardian = screen.getByTestId("create-character-guardian");
    expect(guardian.closest("label")!.textContent).toBe("Tengo permiso de mi mamá, papá o tutor");
    fireEvent.click(guardian);
    expect(goDisabled()).toBe(true); // own photo not confirmed yet
    fireEvent.click(screen.getByTestId("create-character-own-photo"));
    expect(goDisabled()).toBe(false);
    fireEvent.click(screen.getByTestId("create-character-go"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toEqual([
      "image/jpeg",
      { ownPhoto: true, ageBand: "13_17", guardianConsent: true },
      { useWhenReady: false },
    ]);
  });

  it("onboarding: saves the companion first, asks for useWhenReady, lets the person carry on", async () => {
    const { api, calls, starts } = fakeApi({ free: true });
    ctx.avatar = api;
    const order: string[] = [];
    const ensureCompanion = vi.fn(async () => (order.push("companion"), true));
    const onStarted = vi.fn();
    const wrapped: AvatarApi = { ...api, start: async (...a) => (order.push("start"), api.start(...a)) };
    ctx.avatar = wrapped;
    renderIt({ onboarding: { ensureCompanion, onStarted } });
    expect(await screen.findByText("Crea tu personaje con tu foto (gratis la primera vez)")).toBeTruthy();
    await pickPhoto();
    consentAdult();
    fireEvent.click(screen.getByTestId("create-character-go"));
    expect(await screen.findByTestId("create-character-carry-on")).toBeTruthy();
    expect(order).toEqual(["companion", "start"]);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(starts[0]![2]).toEqual({ useWhenReady: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    // Done: shown as worn (the server put it on; the component confirms with /use).
    await waitFor(() => expect(screen.getByTestId("create-character-used")).toBeTruthy());
    expect(calls.some((c) => c.startsWith("use:"))).toBe(true);
  });

  it("onboarding: if the companion can't be saved, nothing is started", async () => {
    const { api, calls } = fakeApi({ free: true });
    ctx.avatar = api;
    renderIt({ onboarding: { ensureCompanion: async () => false } });
    await pickPhoto();
    consentAdult();
    fireEvent.click(screen.getByTestId("create-character-go"));
    expect(await screen.findByTestId("create-character-note")).toBeTruthy();
    expect(calls).toEqual([]);
  });
});
