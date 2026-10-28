import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import { MIN_GLIBC, UpdateController, glibcAtLeast, type FoundUpdate, type UpdaterApi } from "../src/lib/updates.js";
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

  it("a Linux older than the build's glibc is told so and never downloads it", async () => {
    const install = vi.fn(async () => undefined);
    const c = new UpdateController({
      ...api(async () => found({ downloadAndInstall: install })),
      libcVersion: async () => "2.35",
    });
    await c.check();
    expect(c.getSnapshot()).toEqual({ step: "tooOld", version: "1.3.0", needs: MIN_GLIBC });
    await c.install();
    expect(install).not.toHaveBeenCalled();
    const ok = new UpdateController({ ...api(async () => found()), libcVersion: async () => "2.39" });
    await ok.check();
    expect(ok.getSnapshot().step).toBe("available");
  });

  it("the gate also holds at install time (the system can't change, but the check can be skipped)", async () => {
    const install = vi.fn(async () => undefined);
    let libc = "2.41";
    const c = new UpdateController({
      ...api(async () => found({ downloadAndInstall: install })),
      libcVersion: async () => libc,
    });
    await c.check();
    libc = "2.31";
    await c.install();
    expect(install).not.toHaveBeenCalled();
    expect(c.getSnapshot().step).toBe("tooOld");
  });

  it("compares glibc versions numerically; off glibc (null) or unreadable passes", () => {
    expect(MIN_GLIBC).toBe("2.39");
    expect(glibcAtLeast("2.39")).toBe(true);
    expect(glibcAtLeast("2.41")).toBe(true);
    expect(glibcAtLeast("3.0")).toBe(true);
    expect(glibcAtLeast("2.35")).toBe(false);
    expect(glibcAtLeast("2.4")).toBe(false);
    expect(glibcAtLeast("1.99")).toBe(false);
    expect(glibcAtLeast(null)).toBe(true);
    expect(glibcAtLeast("weird")).toBe(true);
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

  it("tells an old Linux why it won't update", async () => {
    const c = new UpdateController({ ...api(async () => found()), libcVersion: async () => "2.35" });
    render(
      <TextProviders locale="en">
        <Updates updates={c} />
      </TextProviders>,
    );
    fireEvent.click(screen.getByText("Check for updates"));
    expect((await screen.findByRole("alert")).textContent).toContain("needs a newer Linux (glibc 2.39");
    expect(screen.queryByText("Download and install")).toBeNull();
    expect(screen.getByText("Check for updates")).toBeTruthy();
  });
});
