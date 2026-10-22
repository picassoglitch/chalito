// ADR 0031 tests that load the real agent need the node transform (packages/config resolves files
// via import.meta.url), so they run in node with this DOM installed before React is imported.
// @ts-expect-error -- jsdom ships no types here; only the constructor is used
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const g = globalThis as Record<string, unknown>;
const w = dom.window as unknown as Record<string, unknown>;
for (const k of Object.getOwnPropertyNames(w))
  if (!(k in g))
    try {
      g[k] = w[k];
    } catch {
      /* read-only global */
    }
g.window = dom.window;
g.document = dom.window.document;
g.IS_REACT_ACT_ENVIRONMENT = true;
