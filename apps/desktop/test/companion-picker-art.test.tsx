import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionPicker } from "@chalito/ui";
import { TextProviders } from "../src/lib/i18n.js";

/** The desktop picker showed blank circles: no window told it where the roster art is served. */

afterEach(cleanup);

const roster = join(dirname(fileURLToPath(import.meta.resolve("@chalito/roster"))), "..");

describe("companion picker on the desktop", () => {
  it("draws each companion from the art served under /roster", () => {
    const { container } = render(
      <TextProviders locale="es">
        <CompanionPicker value="luna" onChange={() => undefined} />
      </TextProviders>,
    );
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "");
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      expect(src).toMatch(/^\/roster\/assets\/[^/]+\/thumb-128\.webp$/);
      // copy-roster.mjs copies @chalito/roster's assets/ to /roster/assets/, so the file must exist there.
      expect(existsSync(join(roster, src.replace(/^\/roster\//, "")))).toBe(true);
    }
  });
});
