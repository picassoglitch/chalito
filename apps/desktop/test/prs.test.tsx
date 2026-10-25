import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityTracker, type Activity } from "@chalito/avatar";
import { TextProviders } from "../src/lib/i18n.js";
import { invokeIpc } from "../src/lib/ipc.js";
import { PrFeed, PrNews, parseRepoList, withPrNews, type PrEventView, type PrWatchView } from "../src/lib/prs.js";
import { petReaction } from "../src/pet/reactions.js";
import { PrList, PrSettings, forgetDismissedHints } from "../src/panel/Prs.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  forgetDismissedHints();
});

const off: PrWatchView = {
  enabled: false,
  state: "off",
  login: null,
  checkedAt: null,
  allow: [],
  deny: [],
  prs: [],
  events: [],
  gh: "ready",
};
const ev = (kind: PrEventView["kind"], seenAt: number, key = `${kind}:${seenAt}`): PrEventView => ({
  repo: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  title: "Cobro recurrente",
  kind,
  key,
  by: "luis",
  seenAt,
  session: null,
});
const on: PrWatchView = {
  ...off,
  enabled: true,
  state: "ok",
  login: "me",
  gh: null,
  prs: [
    {
      repo: "acme/app",
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      title: "Cobro recurrente",
      branch: "feat/7-cobro",
      draft: false,
      review: "changes_requested",
      ci: "failing",
      comments: 2,
    },
  ],
  events: [{ ...ev("changes_requested", 10), session: { sid: "s1", label: "Cobro" } }, ev("merged", 9)],
};

const show = (ui: React.ReactNode, locale: "es" | "en" = "es") =>
  render(<TextProviders locale={locale}>{ui}</TextProviders>);

describe("PR news → the pet's reactions (the same path as session alerts)", () => {
  const zero: Activity = { mode: "rest", done: 0, failed: 0, started: 0, messages: 0, alerts: 0 };
  const react = (before: Activity, now: Activity) =>
    petReaction({ before, now, behaviour: "idle", quiet: false, playing: null });

  it("changes requested and red CI glance; approved and merged hop; green CI stays in the list", () => {
    const news = new PrNews();
    const t0 = 1000;
    let before = withPrNews(zero, news.update({ ...on, events: [] }, t0));
    const step = (events: PrEventView[]) => {
      const now = withPrNews(zero, news.update({ ...on, events }, t0 + 1));
      const r = react(before, now);
      before = now;
      return r?.action ?? null;
    };
    expect(step([ev("changes_requested", t0 + 1)])).toBe("glance");
    expect(step([ev("ci_failed", t0 + 2)])).toBe("glance");
    expect(step([ev("approved", t0 + 3)])).toBe("hop");
    expect(step([ev("merged", t0 + 4)])).toBe("hop");
    expect(step([ev("ci_passed", t0 + 5)])).toBeNull();
    expect(step([ev("comments", t0 + 6)])).toBe("glance");
  });

  it("each key once, and news the agent saw before this panel started never replays", () => {
    const news = new PrNews();
    expect(news.update({ ...on, events: [ev("approved", 5)] }, 100)).toEqual({ alerts: 0, happy: 0 });
    const a = ev("ci_failed", 150);
    expect(news.update({ ...on, events: [a] }, 200)).toEqual({ alerts: 1, happy: 0 });
    expect(news.update({ ...on, events: [a] }, 300)).toEqual({ alerts: 1, happy: 0 });
    expect(news.update(null, 400)).toEqual({ alerts: 1, happy: 0 });
  });

  it("adds to the sessions' own counts without hiding them", () => {
    const tr = new ActivityTracker();
    const act = tr.update([], 0, { now: 1 });
    expect(withPrNews({ ...act, alerts: 2, done: 1 }, { alerts: 1, happy: 3 })).toMatchObject({ alerts: 3, done: 4 });
  });

  it.each([
    ["quiet hours", { quiet: true }],
    ["an escalation already calling", { behaviour: "wave" as const }],
  ])("the alert glance stays muted in %s, like every attention move", (_name, o) => {
    const now = withPrNews(zero, { alerts: 1, happy: 0 });
    expect(petReaction({ before: zero, now, behaviour: "idle", quiet: false, playing: null, ...o })).toBeNull();
  });
});

describe("PR list in Bandeja", () => {
  it("renders nothing while off, and never asks the agent to probe gh", async () => {
    const prWatch = vi.fn(async () => off);
    const { container } = show(<PrList ipc={{ prWatch }} />);
    await waitFor(() => expect(prWatch).toHaveBeenCalled());
    expect(prWatch).toHaveBeenCalledWith(undefined);
    expect(container.querySelector('[data-section="prs"]')).toBeNull();
  });

  it("error, empty and one-comment states; without a browser opener the name is plain text", async () => {
    const one = { ...on, prs: [{ ...on.prs[0]!, comments: 1 }], events: [] };
    const a = show(<PrList ipc={{ prWatch: async () => one }} />);
    await waitFor(() => expect(a.container.textContent).toContain("1 comentario nuevo"));
    expect(a.container.querySelector("[data-pr] button")).toBeNull();
    a.unmount();
    const b = show(<PrList ipc={{ prWatch: async () => ({ ...on, prs: [], events: [] }) }} />);
    await screen.findByText("No tienes PRs abiertos.");
    b.unmount();
    show(<PrList ipc={{ prWatch: async () => ({ ...on, state: "error" as const }) }} />);
    await screen.findByText(/No se pudo leer GitHub/);
  });

  it("the hint stays dismissed for this run even when storage is blocked", async () => {
    const view = { ...on, state: "logged_out" as const, prs: [], events: [] };
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const first = show(<PrList ipc={{ prWatch: async () => view }} />);
    fireEvent.click(await screen.findByText("Entendido"));
    first.unmount();
    const again = show(<PrList ipc={{ prWatch: async () => view }} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(again.container.querySelector("[data-pr-hint]")).toBeNull();
    setItem.mockRestore();
  });

  it("the pet's feed keeps the last view when the agent is away and never waits on it", async () => {
    let answer: PrWatchView | Error = { ...on, events: [] };
    const feed = new PrFeed(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    await feed.refresh();
    expect(feed.counts(100)).toEqual({ alerts: 0, happy: 0 });
    answer = { ...on, events: [ev("merged", 200)] };
    await feed.refresh();
    answer = new Error("agent_ipc_unavailable");
    await feed.refresh();
    expect(feed.counts(300)).toEqual({ alerts: 0, happy: 1 });
  });

  it("shows open PRs with their status and the news tied to its session or general", async () => {
    const openUrl = vi.fn(async () => undefined);
    const { container } = show(<PrList ipc={{ prWatch: async () => on }} openUrl={openUrl} />);
    await screen.findByText("Tus PRs en GitHub");
    const row = container.querySelector('[data-pr="acme/app#7"]')!;
    expect(row.textContent).toContain("Piden cambios · CI falló · 2 comentarios nuevos");
    fireEvent.click(screen.getByText("acme/app#7"));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/app/pull/7");
    expect(container.querySelector('[data-pr-event="changes_requested"]')!.textContent).toContain(
      "luis pidió cambios en el PR #7",
    );
    expect(container.querySelector('[data-session="s1"]')!.textContent).toContain("en la sesión «Cobro»");
    expect(container.querySelector('[data-pr-event="merged"]')!.textContent).toContain("sin sesión abierta");
  });

  it.each(["gh_missing", "logged_out"] as const)(
    "%s: one clear hint, and once dismissed it never comes back",
    async (state) => {
      const view = { ...on, state, prs: [], events: [] };
      const first = show(<PrList ipc={{ prWatch: async () => view }} />);
      await waitFor(() => expect(first.container.querySelector(`[data-pr-hint="${state}"]`)).not.toBeNull());
      expect(first.container.textContent).toContain("gh auth login");
      fireEvent.click(screen.getByText("Entendido"));
      expect(first.container.querySelector("[data-pr-hint]")).toBeNull();
      first.unmount();
      const again = show(<PrList ipc={{ prWatch: async () => view }} />);
      await new Promise((r) => setTimeout(r, 10));
      expect(again.container.querySelector("[data-pr-hint]")).toBeNull();
    },
  );
});

describe("PR settings", () => {
  it("off by default, says gh is ready, and turning it on goes to the agent", async () => {
    const setPrWatch = vi.fn(async () => ({ ...on, prs: [] }));
    const { container } = show(<PrSettings ipc={{ prWatch: async () => off, setPrWatch }} />);
    const box = (await screen.findByLabelText("Avisarme de mis PRs en GitHub")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(container.querySelector("[data-pr-status]")!.textContent).toBe("gh ya tiene tu sesión: puedes activarlo.");
    fireEvent.click(box);
    await waitFor(() => expect(setPrWatch).toHaveBeenCalledWith({ enabled: true }));
    await screen.findByText("Viendo los PRs de me.");
  });

  it("saves the lists, reading a bare owner as owner/* and a pasted GitHub link as owner/repo", async () => {
    const setPrWatch = vi.fn(async (c: { allow?: string[]; deny?: string[] }) => ({ ...on, ...c }));
    show(<PrSettings ipc={{ prWatch: async () => on, setPrWatch }} />, "en");
    const deny = await screen.findByLabelText("Except these repos");
    fireEvent.change(deny, { target: { value: "acme/secret, https://github.com/acme/web.git, other" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(setPrWatch).toHaveBeenCalledWith({ allow: [], deny: ["acme/secret", "acme/web", "other/*"] }),
    );
  });

  it("an entry it can't read is shown and nothing is saved, so a deny list never loses one quietly", async () => {
    const setPrWatch = vi.fn(async () => on);
    show(<PrSettings ipc={{ prWatch: async () => on, setPrWatch }} />);
    fireEvent.change(await screen.findByLabelText("Excepto estos repos"), { target: { value: "acme/mi repo, ok/*" } });
    fireEvent.click(screen.getByText("Guardar"));
    expect((await screen.findByRole("alert")).textContent).toContain("No se entiende: acme/mi repo");
    expect(setPrWatch).not.toHaveBeenCalled();
    expect(parseRepoList(Array.from({ length: 51 }, (_, i) => `a/r${i}`).join(",")).valid).toHaveLength(51);
    fireEvent.change(screen.getByLabelText("Excepto estos repos"), {
      target: { value: Array.from({ length: 51 }, (_, i) => `a/r${i}`).join(",") },
    });
    fireEvent.click(screen.getByText("Guardar"));
    expect((await screen.findByRole("alert")).textContent).toBe("Máximo 50 repos por lista.");
    expect(setPrWatch).not.toHaveBeenCalled();
  });

  it("a save the agent refused says so; the switch shows the probe answers", async () => {
    const setPrWatch = vi.fn(async () => {
      throw new Error("internal");
    });
    const prWatch = vi.fn(async () => ({ ...off, gh: "missing" as const }));
    const { container } = show(<PrSettings ipc={{ prWatch, setPrWatch }} />);
    fireEvent.click(await screen.findByLabelText("Avisarme de mis PRs en GitHub"));
    expect((await screen.findByRole("alert")).textContent).toBe("No se pudo guardar. Intenta de nuevo.");
    expect(container.querySelector("[data-pr-status]")!.textContent).toContain("No encontramos gh");
    expect(prWatch).toHaveBeenCalledWith({ probe: true });
  });

  it("a slow read that started before the switch was flipped doesn't undo it", async () => {
    let slow!: (v: PrWatchView) => void;
    const prWatch = vi
      .fn<(o?: { probe?: boolean }) => Promise<PrWatchView>>()
      .mockResolvedValueOnce(off)
      .mockImplementationOnce(() => new Promise((r) => (slow = r)));
    const setPrWatch = vi.fn(async () => ({ ...on, prs: [] }));
    show(<PrSettings ipc={{ prWatch, setPrWatch }} />);
    const box = (await screen.findByLabelText("Avisarme de mis PRs en GitHub")) as HTMLInputElement;
    window.dispatchEvent(new Event("focus"));
    fireEvent.click(box);
    await screen.findByText("Viendo los PRs de me.");
    slow(off);
    await new Promise((r) => setTimeout(r, 10));
    expect(box.checked).toBe(true);
  });

  it("gh missing while on: one Try again button retries in a single step", async () => {
    const setPrWatch = vi.fn(async () => on);
    show(<PrSettings ipc={{ prWatch: async () => ({ ...on, state: "gh_missing" as const }), setPrWatch }} />, "en");
    fireEvent.click(await screen.findByText("Try again"));
    await waitFor(() => expect(setPrWatch).toHaveBeenCalledWith({ enabled: true }));
  });

  it("goes through the native agent_ipc command with the agent's method names", async () => {
    const invoke = vi.fn(async () => off);
    const ipc = invokeIpc(invoke as never);
    await ipc.prWatch();
    await ipc.setPrWatch({ enabled: true });
    expect(invoke.mock.calls).toEqual([
      ["agent_ipc", { method: "prWatch", params: null }],
      ["agent_ipc", { method: "setPrWatch", params: { enabled: true } }],
    ]);
  });
});
