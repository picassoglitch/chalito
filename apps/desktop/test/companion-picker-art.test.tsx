import { existsSync, readFileSync } from "node:fs";
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

  it("keeps each hidden radio inside its tile, so a click doesn't scroll the panel to a blank area", () => {
    const { container } = render(
      <TextProviders locale="es">
        <CompanionPicker value="luna" onChange={() => undefined} />
      </TextProviders>,
    );
    const labels = [...container.querySelectorAll('label:has(input[name="companion"])')];
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l.classList.contains("relative")).toBe(true);
    // The desktop has no Tailwind: styles.css must define the class for the shell.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css"), "utf8");
    expect(css).toMatch(/\[data-shell="desktop"\] \.relative \{\s*position: relative;/);
  });
});
