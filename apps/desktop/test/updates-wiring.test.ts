// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (cmd: string) => (cmd === "libc_version" ? "2.39" : null));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { tauriUpdater } = await import("../src/lib/updates.js");

describe("the updater's glibc check reaches the Rust command", () => {
  it("invokes libc_version, which every Linux build registers", async () => {
    expect(await tauriUpdater.libcVersion?.()).toBe("2.39");
    expect(invoke).toHaveBeenCalledWith("libc_version");
    const rs = readFileSync(join(__dirname, "../src-tauri/src/lib.rs"), "utf8");
    const handlers = rs.split("generate_handler![").slice(1);
    expect(handlers.length).toBeGreaterThan(0);
    // A name drift would leave every Linux user on "couldn't check" forever.
    for (const h of handlers) expect(h.slice(0, h.indexOf("]"))).toMatch(/\blibc_version,/);
  });
});
