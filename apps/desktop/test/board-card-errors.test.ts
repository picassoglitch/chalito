import { afterEach, expect, it } from "vitest";
import { localCardErrors } from "../src/lib/board/card-errors.js";

afterEach(() => localStorage.clear());

it("shares the card error through localStorage and hears another window's change", () => {
  const pet = localCardErrors();
  const panel = localCardErrors();
  let heard = 0;
  panel.onChange(() => heard++);
  pet.set("card-ack hash");
  // Another window: the browser fires `storage` there, never in the window that wrote it.
  window.dispatchEvent(new StorageEvent("storage", { key: "chalito-board-card-error" }));
  expect(heard).toBe(1);
  expect(panel.get()).toBe("card-ack hash");
  // A panel opened after the failure still sees it.
  expect(localCardErrors().get()).toBe("card-ack hash");
  pet.set(null);
  window.dispatchEvent(new StorageEvent("storage", { key: "chalito-board-card-error" }));
  expect(panel.get()).toBeNull();
  expect(heard).toBe(2);
  window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
  expect(heard).toBe(2);
});
