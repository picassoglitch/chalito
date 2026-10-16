import catalogJson from "../../../recipes/catalog.json" with { type: "json" };
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import { unavailableIpc, type AgentIpc, type AppPinView, type AppView } from "../src/lib/ipc.js";
import type { AgentStatus } from "../src/lib/local-agent.js";
import { firstTaskUrl } from "../src/lib/session.js";
import { SetupChecklist, pinnedSessionApps } from "../src/panel/SetupChecklist.js";

/** First Run D (ADR 0028 §6): the panel's checklist reads this computer's real state. */

afterEach(cleanup);

const recipes = catalogJson as unknown as { recipes: AppView["recipe"][] };
const app = (appId: string, pin: AppPinView["state"] | null): AppView =>
  ({
    appId,
    recipe: recipes.recipes.find((r) => r.id === appId)!,
    pin: pin ? { state: pin, path: null, detected: null, sha256: null } : null,
  }) as unknown as AppView;

const live = (sessions: number) => {
  const snap = { sessions: Array.from({ length: sessions }, (_, i) => ({ sid: `s${i}` })) };
  return { live: { subscribe: () => () => undefined, getSnapshot: () => snap } } as never;
};

const ipcWith = (apps: AppView[], folders: number): AgentIpc => ({
  ...unavailableIpc,
  apps: async () => ({ apps, problems: [], catalog: null }),
  workspaces: async () => ({
    workspaces: Array.from({ length: folders }, (_, i) => ({ label: `p${i}`, path: `/x/p${i}` })),
  }),
});

const running: () => Promise<AgentStatus> = async () => ({ state: "running", pid: 1 });

const show = (props: Partial<Parameters<typeof SetupChecklist>[0]> & { ipc: AgentIpc }) => {
  const openTab = vi.fn();
  const openUrl = vi.fn(async () => undefined);
  render(
    <TextProviders locale="es">
      <SetupChecklist client={null} openTab={openTab} openUrl={openUrl} pollMs={10_000} {...props} />
    </TextProviders>,
  );
  return { openTab, openUrl };
};

const stepDone = (id: string) =>
  screen.getByTestId("setup-checklist").querySelector(`[data-step="${id}"]`)!.getAttribute("data-done");

describe("desktop setup checklist", () => {
  it("counts only pinned apps that run sessions", () => {
    expect(
      pinnedSessionApps([app("claude-code", "pinned"), app("codex", "not_pinned"), app("aider", "pinned")]),
    ).toEqual(["claude-code"]);
  });

  it("signed out: the first step is the account, and its button opens the Inbox", () => {
    const { openTab } = show({ ipc: ipcWith([], 0) });
    expect(stepDone("account")).toBe("false");
    fireEvent.click(screen.getByTestId("setup-go-account"));
    expect(openTab).toHaveBeenCalledWith("inbox");
  });

  it("paired with no AI yet: the next step goes to the AI tab", async () => {
    const { openTab } = show({
      client: live(0),
      ipc: ipcWith([app("claude-code", "not_pinned")], 0),
      agentStatus: running,
    });
    await waitFor(() => expect(stepDone("computer")).toBe("true"));
    expect(stepDone("ai")).toBe("false");
    fireEvent.click(screen.getByTestId("setup-go-ai"));
    expect(openTab).toHaveBeenCalledWith("ai");
  });

  it("an AI but no folder: the next step goes to Ajustes", async () => {
    const { openTab } = show({
      client: live(0),
      ipc: ipcWith([app("claude-code", "pinned")], 0),
      agentStatus: running,
    });
    await waitFor(() => expect(stepDone("ai")).toBe("true"));
    fireEvent.click(screen.getByTestId("setup-go-folder"));
    expect(openTab).toHaveBeenCalledWith("settings");
  });

  it("all set but no task yet: opens the hub's ready-made first task", async () => {
    const url = firstTaskUrl("https://www.chalyb.com/app/chalito/auth/desktop")!;
    const { openUrl } = show({
      client: live(0),
      ipc: ipcWith([app("claude-code", "pinned")], 1),
      agentStatus: running,
      firstTaskUrl: url,
    });
    await waitFor(() => expect(stepDone("folder")).toBe("true"));
    fireEvent.click(screen.getByTestId("setup-go-firstTask"));
    expect(openUrl).toHaveBeenCalledWith("https://www.chalyb.com/app/chalito/sesiones/nueva?first=1");
  });

  it("not paired: the computer step has no button (the Connect card above does it)", async () => {
    show({ client: live(0), ipc: ipcWith([], 0), agentStatus: async () => ({ state: "not_paired" }) });
    await waitFor(() => expect(stepDone("computer")).toBe("false"));
    expect(screen.queryByTestId("setup-go-computer")).toBeNull();
  });

  it("disappears once a session has run on a paired computer", async () => {
    show({ client: live(1), ipc: ipcWith([], 0), agentStatus: running });
    await waitFor(() => expect(screen.queryByTestId("setup-checklist")).toBeNull());
  });
});

describe("firstTaskUrl", () => {
  it("is the New Session page next to the sign-in page, https only", () => {
    expect(firstTaskUrl("https://www.chalyb.com/app/chalito/auth/desktop")).toBe(
      "https://www.chalyb.com/app/chalito/sesiones/nueva?first=1",
    );
    expect(firstTaskUrl("http://evil.example/app/chalito/auth/desktop")).toBeNull();
    expect(firstTaskUrl("not a url")).toBeNull();
  });
});
