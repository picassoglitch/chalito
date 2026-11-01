import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import { BoardLink } from "../src/lib/board/link.js";
import { BoardNotice } from "../src/panel/BoardNotice.js";
import { FakeBoard } from "./fake-board.js";
import { memoryPairStore } from "../src/lib/board/pairing.js";

afterEach(cleanup);

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
  const link = new BoardLink(board, memoryPairStore());
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
  await act(async () => {
    board.confirmPairing();
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(screen.queryByRole("status")).toBeNull();
});
