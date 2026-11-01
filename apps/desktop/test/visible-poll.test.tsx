import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useVisiblePoll } from "../src/lib/visible-poll.js";

const setVisibility = (v: "visible" | "hidden") =>
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
});

it("pulls only while the window is visible, and once when it comes back", () => {
  vi.useFakeTimers();
  const fn = vi.fn();
  const { unmount } = renderHook(() => useVisiblePoll(fn, 1000));
  vi.advanceTimersByTime(1000);
  expect(fn).toHaveBeenCalledTimes(1);
  setVisibility("hidden");
  vi.advanceTimersByTime(5000);
  expect(fn).toHaveBeenCalledTimes(1);
  setVisibility("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(fn).toHaveBeenCalledTimes(2);
  unmount();
  vi.advanceTimersByTime(5000);
  expect(fn).toHaveBeenCalledTimes(2);
});

it("does nothing without a function (signed out)", () => {
  vi.useFakeTimers();
  renderHook(() => useVisiblePoll(null, 1000));
  vi.advanceTimersByTime(5000);
});
