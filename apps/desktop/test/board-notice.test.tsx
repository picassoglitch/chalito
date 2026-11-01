import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { TextProviders } from "../src/lib/i18n.js";
import { BoardLink, type BoardSnapshot } from "../src/lib/board/link.js";
import { BoardNotice, BoardSettings } from "../src/panel/BoardNotice.js";
import { FakeBoard, prePair } from "./fake-board.js";
import { memoryPairStore } from "../src/lib/board/pairing.js";
import { memoryCardErrors } from "../src/lib/board/card-errors.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const settle = (ms = 10) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const en = (node: ReactNode) => render(<TextProviders locale="en">{node}</TextProviders>);
const pairedLink = async (opts: ConstructorParameters<typeof BoardLink>[2] = {}) => {
  const board = new FakeBoard();
  const store = memoryPairStore();
  await prePair(board, store);
  const link = new BoardLink(board, store, { minPairMs: 0, ...opts });
  link.start();
  return { board, link, store };
};
/** A link stand-in whose snapshot a test sets directly. */
const stubLink = (over: Partial<BoardSnapshot>, more: Partial<Pick<BoardLink, "pair" | "forget">> = {}) => {
  const snap: BoardSnapshot = {
    status: { state: "connected", port: "/dev/ttyACM0" },
    hello: { fw: "0.1.0", board: "b", w: 172, h: 320, card: null, pair: "k" },
    card: "none",
    hasPairing: true,
    paired: true,
    pairing: null,
    rejected: 0,
    cardError: null,
    pairingError: null,
    approvalProblem: null,
    ...over,
  };
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snap,
    pair: async () => "paired" as const,
    forget: async () => "forgotten" as const,
    ...more,
  };
};

it("tells how to fix a board the OS won't open, and says nothing once it works", () => {
  const board = new FakeBoard();
  const link = new BoardLink(board, memoryPairStore());
  link.start();
  const { container } = render(
    <TextProviders locale="en">
      <BoardNotice link={link} />
    </TextProviders>,
  );
  expect(container.innerHTML).toBe("");
  act(() => board.setStatus({ state: "permission", port: "/dev/ttyACM0" }));
  expect(screen.getByRole("alert").textContent).toContain("dialout");
  expect(screen.getByRole("alert").textContent).toContain("/dev/ttyACM0");
  act(() => board.setStatus({ state: "absent" }));
  expect(container.innerHTML).toBe("");
});

it("offers to pair a board that answers, shows the code, and then says nothing", async () => {
  const board = new FakeBoard();
  const link = new BoardLink(board, memoryPairStore(), { minPairMs: 0 });
  link.start();
  render(
    <TextProviders locale="es">
      <BoardNotice link={link} />
    </TextProviders>,
  );
  await act(async () => {
    board.plug();
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(screen.getByRole("status").textContent).toContain("Placa encontrada");
  await act(async () => {
    screen.getByRole("button", { name: "Emparejar" }).click();
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(screen.getByRole("status").textContent).toContain("mantén BOOT");
  expect(screen.getByRole("status").textContent).toContain(board.pending!.code);
  // Which device is being paired: the port the board is on.
  expect(screen.getByRole("status").textContent).toContain("/dev/fake");
  await act(async () => {
    board.confirmPairing();
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(screen.queryByRole("status")).toBeNull();
});

it("tells the panel the pet window couldn't send the card, and why", async () => {
  const errors = memoryCardErrors();
  const { board, link } = await pairedLink({ cardErrors: errors });
  en(<BoardNotice link={link} />);
  await act(async () => board.plug());
  await settle();
  act(() => errors.set("card-ack hash"));
  expect(screen.getByRole("alert").textContent).toBe("Couldn't send your pet to the board: card-ack hash");
  act(() => errors.set(null));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("says when a pairing couldn't be saved, and survives a pair() that throws", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const saved = stubLink({ paired: false }, { pair: async () => "save-failed" });
  en(<BoardNotice link={saved} />);
  await act(async () => screen.getByRole("button", { name: "Pair" }).click());
  expect(screen.getByRole("status").textContent).toContain("couldn't save");
  cleanup();
  const thrown = stubLink({ paired: false }, { pair: () => Promise.reject(new Error("boom")) });
  en(<BoardNotice link={thrown} />);
  await act(async () => screen.getByRole("button", { name: "Pair" }).click());
  await settle();
  expect(screen.getByRole("status").textContent).toContain("The board wasn't paired.");
  expect(console.error).toHaveBeenCalled();
});

it("says the saved pairing couldn't be read", () => {
  en(<BoardNotice link={stubLink({ paired: false, hasPairing: false, pairingError: "idb closed" })} />);
  expect(screen.getByRole("alert").textContent).toContain("idb closed");
});

it("says the board's buttons were ignored once a decide fails its mac", async () => {
  const { board, link } = await pairedLink();
  en(<BoardNotice link={link} />);
  await act(async () => board.plug());
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => board.decide("a1b2c3d4e5f6", "t".repeat(24), true, "0".repeat(64)));
  await settle(30);
  expect(screen.getByRole("alert").textContent).toContain("pairing mismatch");
});

it("surfaces approvals-screen trouble", () => {
  en(<BoardNotice link={stubLink({ approvalProblem: "send_failed" })} />);
  expect(screen.getByRole("alert").textContent).toContain("didn't reach");
  cleanup();
  en(<BoardNotice link={stubLink({ approvalProblem: "phone_required" })} />);
  expect(screen.getByRole("alert").textContent).toContain("phone");
  cleanup();
  en(<BoardNotice link={stubLink({ approvalProblem: "write_failed" })} />);
  expect(screen.getByRole("alert").textContent).toContain("stopped getting approvals");
});

it("forgetting says when the board didn't confirm, or when this computer couldn't forget", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  en(<BoardSettings link={stubLink({}, { forget: async () => "board-unconfirmed" })} />);
  await act(async () => screen.getByRole("button", { name: "Forget the board" }).click());
  expect(screen.getByRole("alert").textContent).toBe(
    "Forgot it here, but the board didn't confirm; unplug and re-pair to reset it.",
  );
  cleanup();
  en(<BoardSettings link={stubLink({}, { forget: () => Promise.reject(new Error("idb")) })} />);
  await act(async () => screen.getByRole("button", { name: "Forget the board" }).click());
  await settle();
  expect(screen.getByRole("alert").textContent).toContain("couldn't forget");
});
