import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import { UpdateController, type FoundUpdate, type UpdaterApi } from "../src/lib/updates.js";
import { Updates } from "../src/panel/Updates.js";

afterEach(cleanup);

const found = (over: Partial<FoundUpdate> = {}): FoundUpdate => ({
  version: "1.3.0",
  body: "Mejoras",
  downloadAndInstall: async (onEvent) => {
    onEvent?.({ event: "Started", data: { contentLength: 200 } });
    onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
    onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
    onEvent?.({ event: "Finished" });
  },
  close: vi.fn(async () => undefined),
  ...over,
});
const api = (check: UpdaterApi["check"]): UpdaterApi & { relaunch: ReturnType<typeof vi.fn> } => ({
  check,
  relaunch: vi.fn(async () => undefined),
});

describe("update controller", () => {
  it("check → available → download (progress) → ready → relaunch", async () => {
    const a = api(async () => found());
    const c = new UpdateController(a);
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.getSnapshot().step));
    await c.check();
    expect(c.getSnapshot()).toEqual({ step: "available", version: "1.3.0", notes: "Mejoras" });
    await c.install();
    expect(c.getSnapshot()).toEqual({ step: "ready", version: "1.3.0" });
    expect(seen).toEqual([
      "checking",
      "available",
      "downloading",
      "downloading",
      "downloading",
      "downloading",
      "downloading",
      "ready",
    ]);
    await c.relaunch();
    expect(a.relaunch).toHaveBeenCalled();
  });

  it("no update, no updater in this build, or a failure", async () => {
    const none = new UpdateController(api(async () => null));
    await none.check();
    expect(none.getSnapshot().step).toBe("current");
    const dev = new UpdateController(
      api(() => Promise.reject(new Error("updater.check not allowed. Plugin not found"))),
    );
    await dev.check();
    expect(dev.getSnapshot().step).toBe("unavailable");
    const offline = new UpdateController(api(() => Promise.reject(new Error("error sending request"))));
    await offline.check();
    expect(offline.getSnapshot().step).toBe("error");
  });

  it("a bad signature (the install throws) installs nothing and reports an error", async () => {
    const c = new UpdateController(
      api(async () => found({ downloadAndInstall: () => Promise.reject(new Error("signature verification failed")) })),
    );
    await c.check();
    await c.install();
    expect(c.getSnapshot().step).toBe("error");
  });

  it("install without an update does nothing; a new check releases the old one", async () => {
    const first = found();
    let n = 0;
    const c = new UpdateController(api(async () => (n++ === 0 ? first : null)));
    await c.install();
    expect(c.getSnapshot().step).toBe("idle");
    await c.check();
    await c.check();
    expect(first.close).toHaveBeenCalled();
  });
});

describe("updates screen", () => {
  it("shows the new version, installs and offers a restart", async () => {
    const a = api(async () => found());
    const c = new UpdateController(a);
    render(
      <TextProviders locale="en">
        <Updates updates={c} />
      </TextProviders>,
    );
    fireEvent.click(screen.getByText("Check for updates"));
    fireEvent.click(await screen.findByText("Download and install"));
    fireEvent.click(await screen.findByText("Restart now"));
    expect(a.relaunch).toHaveBeenCalled();
  });
});
