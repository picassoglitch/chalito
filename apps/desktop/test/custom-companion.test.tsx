import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type SettingsValues } from "@chalito/ui";
import type { Locale } from "@chalito/protocol";
import { TextProviders } from "../src/lib/i18n.js";
import { unavailableIpc } from "../src/lib/ipc.js";
import { PushToTalk, unavailableVoice } from "../src/lib/voice.js";
import { Panel } from "../src/panel/Panel.js";
import { DesktopSettings } from "../src/lib/settings-sync.js";
import { companionCardSource } from "../src/lib/custom-card.js";
import {
  CARD_CHANGED_KEY,
  CustomCompanion,
  httpCompanionAvatar,
  refreshOnStorage,
} from "../src/lib/custom-companion.js";

/** Owner 2026-11-02: pick the character you built as the desktop pet, like in the PWA. */

const BASE = "https://api.test";
const ASSET = "0123456789abcdef0123456789abcdef";
const GCS = `https://storage.googleapis.com/chalito-avatars/avatars/o/${ASSET}`;
const THUMB = `${GCS}/thumb-128.webp?sig=1`;
const CARD = {
  assetId: ASSET,
  card: {
    manifest: {
      width: 600,
      height: 800,
      emotions: { mode: "swap", src: { neutral: "layer-neutral.webp" } },
      thumbs: { "128": "thumb-128.webp" },
      anchors: { head: { x: 0.5, y: 0.1, z: 1 } },
    },
    urls: { "layer-neutral.webp": `${GCS}/layer-neutral.webp?s`, "thumb-128.webp": `${GCS}/thumb-128.webp?s` },
    expiresAt: 1_800_000_000_000,
  },
};

// The api and settings RPCs over one companion row, like the database: /use sets the worn
// character, and an avatar change clears it (companions trigger, migration 20261005000100).
const backend = (o: { worn?: string | null; kept?: string[]; useStatus?: number; down?: boolean } = {}) => {
  const state = { worn: o.worn ?? null, avatar: "luna", useStatus: o.useStatus ?? 200 };
  const kept = o.kept ?? ["cr_new", "cr_old"];
  const log: string[] = [];
  const held = new Map<string, Promise<void>[]>();
  /** The next request to `path` waits until released, then reads the row. */
  const hold = (path: string) => {
    let release!: () => void;
    held.set(path, [...(held.get(path) ?? []), new Promise<void>((r) => (release = r))]);
    return { release };
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(`${BASE}/v1/avatar`, "");
    if (o.down) return new Response("down", { status: 503 });
    if (new Headers(init?.headers).get("authorization") !== "Bearer device-token")
      return new Response("no", { status: 401 });
    const gate = held.get(path)?.shift();
    if (path === "/use") {
      const { creationId } = JSON.parse(String(init!.body)) as { creationId: string | null };
      log.push(`use:${creationId}`);
      await gate;
      if (state.useStatus !== 200) return Response.json({ error: "x" }, { status: state.useStatus });
      state.worn = creationId;
      return Response.json({ ok: true });
    }
    log.push(`GET ${path}`);
    await gate;
    if (path === "/creations")
      return Response.json({
        creations: kept.map((id, i) => ({
          creationId: id,
          createdAt: kept.length - i,
          worn: id === state.worn,
          ...(i === 0 ? { thumb: THUMB } : {}),
        })),
      });
    if (path === "/companion") return Response.json(state.worn ? CARD : { assetId: null });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const settings = {
    load: async () => ({ values: { ...DEFAULT_SETTINGS, avatar: state.avatar } as SettingsValues, onboarded: true }),
    save: async () => undefined,
    saveCompanion: async (v: Pick<SettingsValues, "avatar" | "companionName">) => {
      log.push(`saveCompanion:${v.avatar}`);
      if (v.avatar !== state.avatar) state.worn = null;
      state.avatar = v.avatar;
    },
  };
  return { state, log, hold, fetchImpl, settings };
};

/** The panel's wiring (main.tsx): DesktopSettings + CustomCompanion behind the real Panel. */
const mount = (b: ReturnType<typeof backend>, o: { locale?: Locale; signedOut?: boolean } = {}) => {
  const store = new DesktopSettings(b.settings, { load: () => DEFAULT_SETTINGS, save: () => undefined });
  const custom = o.signedOut
    ? null
    : new CustomCompanion(
        httpCompanionAvatar(BASE, async () => "device-token", b.fetchImpl),
        { beforeWear: () => store.flushCompanion() },
      );
  const App = () => {
    const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
    return (
      <Panel
        client={null}
        ipc={unavailableIpc}
        ptt={new PushToTalk(unavailableVoice)}
        settings={view.values}
        onSetting={(k, v) => store.set(k, v)}
        settingsError={view.error}
        customCompanion={custom}
        dnd={false}
        onDnd={() => undefined}
        hubPlansUrl="https://hub.example/planes"
        phoneVerifier={{ start: async () => ({ ok: true }), check: async () => ({ ok: true }) }}
        initialTab="settings"
      />
    );
  };
  render(
    <TextProviders locale={o.locale ?? "es"}>
      <App />
    </TextProviders>,
  );
  return { store, custom: custom! };
};

/** Lets fetches, bodies and renders settle (setTimeout is faked: the debounce only moves on purpose). */
const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await act(() => new Promise<void>((r) => setImmediate(r)));
};
const ready = async (store: DesktopSettings) => {
  await act(() => store.start());
  await settle();
};
const debounce = async () => {
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  await settle();
};

const radios = () => within(screen.getByTestId("companion-picker")).getAllByRole("radio") as HTMLInputElement[];
const own = () => radios()[0]!;
const roster = (value: string) => radios().find((r) => r.value === value)!;
const checked = () =>
  radios()
    .filter((r) => r.checked)
    .map((r) => r.value);

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("desktop companion picker: your own character", () => {
  it("shows no tile and no error while signed out", async () => {
    const { store } = mount(backend(), { signedOut: true });
    await ready(store);
    expect(screen.queryByTestId("companion-own")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["none kept", { kept: [] }],
    ["the api is down", { down: true }],
  ])("shows no tile and no error when %s", async (_, o) => {
    const { store } = mount(backend(o));
    await ready(store);
    expect(screen.queryByTestId("companion-own")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(checked()).toEqual(["luna"]);
  });

  it("lists the newest character first, with its picture, as the device", async () => {
    const b = backend();
    const { store } = mount(b, { locale: "en" });
    await ready(store);
    const tile = screen.getByTestId("companion-own");
    expect(own().value).toBe("own");
    expect(tile.textContent).toContain("Your character");
    expect(tile.querySelector("img")?.getAttribute("src")).toBe(THUMB);
    expect(b.log).toEqual(["GET /creations"]);
    expect(own().checked).toBe(false);
  });

  it("wears it on tap, marks it chosen and tells the pet window", async () => {
    const b = backend();
    const { store } = mount(b);
    await ready(store);
    fireEvent.click(own());
    await settle();
    expect(b.log).toEqual(["GET /creations", "use:cr_new"]);
    expect(checked()).toEqual(["own"]);
    expect(screen.getByTestId("companion-custom")).toBeTruthy();
    expect(localStorage.getItem(CARD_CHANGED_KEY)).not.toBeNull();
    expect(b.state.worn).toBe("cr_new");
  });

  it("goes back to the roster only once the server stopped wearing it", async () => {
    const b = backend({ worn: "cr_new" });
    const { store } = mount(b);
    await ready(store);
    expect(checked()).toEqual(["own"]);
    const gate = b.hold("/use");
    fireEvent.click(roster("bruno"));
    await settle();
    expect(store.getSnapshot().values?.avatar).toBe("luna");
    gate.release();
    await settle();
    expect(store.getSnapshot().values?.avatar).toBe("bruno");
    expect(checked()).toEqual(["bruno"]);
    await debounce();
    expect(b.log.slice(1)).toEqual(["use:null", "saveCompanion:bruno"]);
    expect(b.state).toMatchObject({ worn: null, avatar: "bruno" });
    expect(localStorage.getItem(CARD_CHANGED_KEY)).not.toBeNull();
  });

  it("a roster pick when not wearing it doesn't call /use", async () => {
    const b = backend();
    const { store } = mount(b);
    await ready(store);
    fireEvent.click(roster("bruno"));
    expect(store.getSnapshot().values?.avatar).toBe("bruno");
    await debounce();
    expect(b.log.slice(1)).toEqual(["saveCompanion:bruno"]);
  });

  it("roster pick then own tile within the debounce: the avatar lands first, so the character stays on", async () => {
    const b = backend();
    const { store } = mount(b);
    await ready(store);
    fireEvent.click(roster("bruno"));
    await act(() => vi.advanceTimersByTimeAsync(100));
    fireEvent.click(own());
    await settle();
    await debounce();
    expect(b.log.slice(1)).toEqual(["saveCompanion:bruno", "use:cr_new"]);
    expect(b.state).toMatchObject({ worn: "cr_new", avatar: "bruno" });
    expect(checked()).toEqual(["own"]);
  });

  it("own tile tapped while going back to the roster: the last pick wins", async () => {
    const b = backend({ worn: "cr_new" });
    const { store } = mount(b);
    await ready(store);
    const gate = b.hold("/use");
    fireEvent.click(roster("bruno"));
    await settle();
    fireEvent.click(own());
    await settle();
    gate.release();
    await settle();
    await debounce();
    expect(b.log.slice(1)).toEqual(["use:null", "saveCompanion:bruno", "use:cr_new"]);
    expect(b.state).toMatchObject({ worn: "cr_new", avatar: "bruno" });
    expect(checked()).toEqual(["own"]);
  });

  it("a failed wear says so and keeps the selection", async () => {
    const b = backend({ useStatus: 500 });
    const { store } = mount(b, { locale: "en" });
    await ready(store);
    fireEvent.click(own());
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Couldn't switch your character. Try again.");
    expect(checked()).toEqual(["luna"]);
    expect(localStorage.getItem(CARD_CHANGED_KEY)).toBeNull();
  });

  it("a failed switch back to the roster changes nothing and re-reads what the server wears", async () => {
    const b = backend({ worn: "cr_new", useStatus: 500 });
    const { store } = mount(b, { locale: "en" });
    await ready(store);
    fireEvent.click(roster("bruno"));
    await settle();
    await debounce();
    expect(screen.getByRole("alert").textContent).toBe("Couldn't switch your character. Try again.");
    expect(checked()).toEqual(["own"]);
    expect(store.getSnapshot().values?.avatar).toBe("luna");
    expect(b.log.slice(1)).toEqual(["use:null", "GET /creations"]);
    expect(b.state).toMatchObject({ worn: "cr_new", avatar: "luna" });
    expect(localStorage.getItem(CARD_CHANGED_KEY)).toBeNull();
  });

  it("a kept list read before a wear doesn't undo it; a fresh read clears an old failure", async () => {
    const b = backend();
    const { store, custom } = mount(b);
    await ready(store);
    const stale = b.hold("/creations");
    const reading = custom.load(); // e.g. the tab opened again
    await settle();
    fireEvent.click(own());
    await settle();
    expect(checked()).toEqual(["own"]);
    b.state.worn = null; // what that earlier read saw
    stale.release();
    await act(() => reading);
    await settle();
    expect(checked()).toEqual(["own"]);

    b.state.worn = "cr_new";
    b.state.useStatus = 500;
    fireEvent.click(roster("bruno"));
    await settle();
    expect(screen.getByRole("alert")).toBeTruthy();
    await act(() => custom.load());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the pet window after a pick", () => {
  it("a card request already running when the panel wears the character doesn't keep the roster pet", async () => {
    vi.useRealTimers();
    const b = backend();
    const card = companionCardSource(async () => ({
      companionCard: async () =>
        (
          await b.fetchImpl(`${BASE}/v1/avatar/companion`, { headers: { authorization: "Bearer device-token" } })
        ).json(),
    }));
    await card.refresh();
    expect(card.getSnapshot()).toBeNull();
    // The pet's periodic refresh is on its way and answers from before the change.
    const before = b.hold("/companion");
    const running = card.refresh();
    const custom = new CustomCompanion(httpCompanionAvatar(BASE, async () => "device-token", b.fetchImpl));
    await custom.load();
    await custom.wear();
    expect(b.state.worn).toBe("cr_new");
    expect(localStorage.getItem(CARD_CHANGED_KEY)).not.toBeNull();
    // The storage event the pet window gets for that write.
    const pet = refreshOnStorage(CARD_CHANGED_KEY, card);
    b.state.worn = null;
    before.release();
    await running;
    b.state.worn = "cr_new";
    await pet;
    expect(card.getSnapshot()?.assetId).toBe(ASSET);
    expect(b.log.filter((l) => l === "GET /companion")).toHaveLength(3);
    card.dispose();
  });
});
