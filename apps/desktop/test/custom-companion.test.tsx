import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@chalito/ui";
import type { Locale } from "@chalito/protocol";
import { TextProviders } from "../src/lib/i18n.js";
import { unavailableIpc } from "../src/lib/ipc.js";
import { PushToTalk, unavailableVoice } from "../src/lib/voice.js";
import { Panel, type PanelProps } from "../src/panel/Panel.js";
import { CustomCompanion, httpCompanionAvatar } from "../src/lib/custom-companion.js";

/** Owner 2026-11-02: pick the character you built as the desktop pet, like in the PWA. */

const BASE = "https://api.test";
const THUMB = "https://storage.googleapis.com/avatars/o/a1/thumb-128.webp?sig=1";
const CARD_KEY = "chalito-desktop-companion-card";

type Call = { method: string; path: string; body: unknown; auth: string | null };

/** The api at the HTTP boundary: GET /creations and POST /use, with scripted answers. */
const fakeApi = (opts: { creations?: unknown[] | "down"; use?: number }) => {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(`${BASE}/v1/avatar`, "");
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    });
    if (path === "/creations") {
      if (opts.creations === "down") return new Response("down", { status: 503 });
      return Response.json({ creations: opts.creations ?? [] });
    }
    if (path === "/use") {
      const status = opts.use ?? 200;
      return status === 200 ? Response.json({ ok: true }) : Response.json({ error: "x" }, { status });
    }
    return new Response("not found", { status: 404 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
};

const kept = (worn: boolean) => [
  { creationId: "cr_new", createdAt: 2, worn, thumb: THUMB },
  { creationId: "cr_old", createdAt: 1, worn: false },
];

const renderSettings = (p: Partial<PanelProps>, locale: Locale = "es") =>
  render(
    <TextProviders locale={locale}>
      <Panel
        client={null}
        ipc={unavailableIpc}
        ptt={new PushToTalk(unavailableVoice)}
        settings={{ ...DEFAULT_SETTINGS, avatar: "luna" }}
        onSetting={() => undefined}
        dnd={false}
        onDnd={() => undefined}
        hubPlansUrl="https://hub.example/planes"
        phoneVerifier={{ start: async () => ({ ok: true }), check: async () => ({ ok: true }) }}
        initialTab="settings"
        {...p}
      />
    </TextProviders>,
  );

const companion = (api: ReturnType<typeof fakeApi>) =>
  new CustomCompanion(httpCompanionAvatar(BASE, async () => "device-token", api.fetchImpl));

const picker = () => screen.getByTestId("companion-picker");
const radios = () => within(picker()).getAllByRole("radio") as HTMLInputElement[];

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("desktop companion picker: your own character", () => {
  it("shows no tile and no error while signed out", () => {
    renderSettings({});
    expect(screen.queryByTestId("companion-own")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["none kept", [] as unknown[]],
    ["the api is down", "down" as const],
  ])("shows no tile and no error when %s", async (_, creations) => {
    const api = fakeApi({ creations });
    renderSettings({ customCompanion: companion(api) });
    await waitFor(() => expect(api.calls.some((c) => c.path === "/creations")).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("companion-own")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // The roster still works as before: the chosen avatar is checked.
    expect(radios().find((r) => r.checked)?.value).toBe("luna");
  });

  it("lists the newest character first, with its picture, as the device", async () => {
    const api = fakeApi({ creations: kept(false) });
    renderSettings({ customCompanion: companion(api) }, "en");
    const tile = await screen.findByTestId("companion-own");
    expect(radios()[0]!.value).toBe("own");
    expect(tile.textContent).toContain("Your character");
    expect(tile.querySelector("img")?.getAttribute("src")).toBe(THUMB);
    expect(api.calls[0]).toMatchObject({ method: "GET", path: "/creations", auth: "Bearer device-token" });
    expect((radios()[0] as HTMLInputElement).checked).toBe(false);
  });

  it("wears it on tap, marks it chosen and tells the pet window", async () => {
    const api = fakeApi({ creations: kept(false) });
    renderSettings({ customCompanion: companion(api) });
    await screen.findByTestId("companion-own");
    fireEvent.click(radios()[0]!);
    await waitFor(() => expect(radios()[0]!.checked).toBe(true));
    expect(api.calls.filter((c) => c.path === "/use")).toEqual([
      { method: "POST", path: "/use", body: { creationId: "cr_new" }, auth: "Bearer device-token" },
    ]);
    expect(
      radios()
        .filter((r) => r.checked)
        .map((r) => r.value),
    ).toEqual(["own"]);
    expect(screen.getByTestId("companion-custom")).toBeTruthy();
    expect(localStorage.getItem(CARD_KEY)).not.toBeNull();
  });

  it("goes back to the roster when a roster pet is picked while wearing it", async () => {
    const api = fakeApi({ creations: kept(true) });
    const onSetting = vi.fn();
    renderSettings({ customCompanion: companion(api), onSetting });
    await waitFor(() => expect(radios()[0]!.checked).toBe(true));
    const luna = radios().find((r) => r.value === "luna")!;
    expect(luna.checked).toBe(false);
    fireEvent.click(luna);
    expect(onSetting).toHaveBeenCalledWith("avatar", "luna");
    await waitFor(() => expect(radios()[0]!.checked).toBe(false));
    expect(api.calls.filter((c) => c.path === "/use").map((c) => c.body)).toEqual([{ creationId: null }]);
    expect(localStorage.getItem(CARD_KEY)).not.toBeNull();
  });

  it("doesn't call /use for a roster pick when not wearing it", async () => {
    const api = fakeApi({ creations: kept(false) });
    const onSetting = vi.fn();
    renderSettings({ customCompanion: companion(api), onSetting });
    await screen.findByTestId("companion-own");
    fireEvent.click(radios().find((r) => !r.checked && r.value !== "own")!);
    expect(onSetting).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls.some((c) => c.path === "/use")).toBe(false);
  });

  it.each([
    ["wearing it", false, 0],
    ["going back to the roster", true, -1],
  ])("a failed use while %s says so and keeps the selection", async (_, worn, pick) => {
    const api = fakeApi({ creations: kept(worn), use: 500 });
    renderSettings({ customCompanion: companion(api) }, "en");
    await screen.findByTestId("companion-own");
    await waitFor(() => expect(radios()[0]!.checked).toBe(worn));
    const before = radios()
      .filter((r) => r.checked)
      .map((r) => r.value);
    fireEvent.click(pick === 0 ? radios()[0]! : radios().find((r) => !r.checked && r.value !== "own")!);
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't switch your character. Try again.");
    expect(radios()[0]!.checked).toBe(worn);
    if (!worn)
      expect(
        radios()
          .filter((r) => r.checked)
          .map((r) => r.value),
      ).toEqual(before);
    expect(localStorage.getItem(CARD_KEY)).toBeNull();
  });
});
