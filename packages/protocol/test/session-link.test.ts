import { expect, it } from "vitest";
import { sessionLink } from "../src/session-link.js";

it("opens the same session on a signed-in phone using the localized route", () => {
  expect(sessionLink("session_123", "en")).toBe("https://www.chalyb.com/en/app/chalito/sesiones/session_123");
  expect(sessionLink("session_123", "es")).toBe("https://www.chalyb.com/app/chalito/sesiones/session_123");
  expect(sessionLink("session_123", "en", "http://localhost:3000")).toBe(
    "http://localhost:3000/en/app/chalito/sesiones/session_123",
  );
});

it("never includes credentials or accepts session path injection", () => {
  expect(() => sessionLink("../other", "en")).toThrow();
  for (const origin of [
    "javascript:alert(1)",
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
    "https://example.com/path",
  ]) {
    expect(() => sessionLink("s1", "en", origin)).toThrow();
  }
});
