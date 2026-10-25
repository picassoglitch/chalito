import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import { anythingFound, invokeCopies, type CopiesApi, type CopiesReport } from "../src/lib/copies.js";
import { OldCopies } from "../src/panel/OldCopies.js";

afterEach(cleanup);

const RUNNING = "/home/ana/Applications/chalito/Chalito.AppImage";
const TEST_COPY = "/home/ana/chalito-dl-test/UNSIGNED_Chalito_0.1.0-beta.2_amd64.AppImage";

const clean: CopiesReport = {
  running: RUNNING,
  autostart: { state: "ours" },
  handler: { state: "ours" },
  copies: [],
  instances: [],
};

/** The owner's machine on 2026-10-25. */
const incident: CopiesReport = {
  ...clean,
  autostart: { state: "other", path: TEST_COPY },
  copies: [
    { path: TEST_COPY, version: "0.1.0-beta.2", bytes: 201456120 },
    { path: "/home/ana/Applications/chalito/Chalito.beta2.AppImage", version: null, bytes: 1 },
  ],
  instances: [{ pid: 4242, kind: "desktop", path: TEST_COPY }],
};

const fake = (first: CopiesReport, after: CopiesReport = clean) => ({
  report: vi.fn(async () => first),
  useThis: vi.fn(async () => after),
  trash: vi.fn(async (_path: string) => after),
  close: vi.fn(async (_pid: number) => after),
});

const show = (api: CopiesApi, locale: "es" | "en" = "es") =>
  render(
    <TextProviders locale={locale}>
      <OldCopies api={api} />
    </TextProviders>,
  );

describe("other copies of Chalito (panel notice)", () => {
  it("stays hidden when this is the only copy, or when the check fails", async () => {
    const api = fake(clean);
    const { container } = show(api);
    await act(async () => {});
    expect(api.report).toHaveBeenCalled();
    expect(container.querySelector("[data-section=old-copies]")).toBeNull();

    cleanup();
    const failing = { ...fake(clean), report: vi.fn(async () => Promise.reject(new Error("x"))) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = show(failing);
    await act(async () => {});
    expect(failing.report).toHaveBeenCalled();
    expect(r.container.querySelector("[data-section=old-copies]")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("lists the mismatch, the other copies and the other open copy, in Spanish first", async () => {
    show(fake(incident));
    await screen.findByText("Revisa las copias de Chalito");
    expect(screen.getByText(`Al encender la computadora se abre otra copia: ${TEST_COPY}`)).toBeTruthy();
    expect(screen.getByText(`Esta copia: ${RUNNING}`)).toBeTruthy();
    expect(screen.getByText(/Copia sin usar \(versión 0\.1\.0-beta\.2\)/)).toBeTruthy();
    expect(screen.getByText(/Copia sin usar: \/home\/ana\/Applications\/chalito\/Chalito\.beta2/)).toBeTruthy();
    expect(screen.getByText(/Otra copia de Chalito está abierta/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Mover a la papelera" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Usar esta copia" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cerrar la otra copia" })).toBeTruthy();
  });

  it("says when an entry points at a copy that is gone, and names an orphaned agent", async () => {
    show(
      fake({
        ...clean,
        handler: { state: "gone", path: "/gone/Chalito.AppImage" },
        instances: [{ pid: 7, kind: "agent", path: "/tmp/.mount_X/usr/bin/chalito-agent (deleted)" }],
      }),
      "en",
    );
    await screen.findByText("Sign-in links (chalito://) point at a copy that no longer exists: /gone/Chalito.AppImage");
    expect(screen.getByText(/A Chalito agent was left running without its app/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close the agent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to trash" })).toBeNull();
  });

  it("runs nothing until a click, then the matching command with its target", async () => {
    const api = fake(incident, incident);
    show(api);
    await screen.findByRole("button", { name: "Usar esta copia" });
    expect(api.useThis).not.toHaveBeenCalled();
    expect(api.trash).not.toHaveBeenCalled();
    expect(api.close).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Mover a la papelera" })[0]!);
    await waitFor(() => expect(api.trash).toHaveBeenCalledWith(TEST_COPY));
    await screen.findByText("Listo: la moví a la papelera.");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar la otra copia" }));
    await waitFor(() => expect(api.close).toHaveBeenCalledWith(4242));

    fireEvent.click(screen.getByRole("button", { name: "Usar esta copia" }));
    await waitFor(() => expect(api.useThis).toHaveBeenCalledTimes(1));
    expect(api.trash).toHaveBeenCalledTimes(1);
    expect(api.close).toHaveBeenCalledTimes(1);
  });

  it("after the last fix the card says done instead of vanishing mid-click", async () => {
    show(fake({ ...clean, copies: [incident.copies[0]!] }));
    fireEvent.click(await screen.findByRole("button", { name: "Mover a la papelera" }));
    await screen.findByText("Listo: la moví a la papelera.");
    expect(screen.queryByText("Copia sin usar", { exact: false })).toBeNull();
  });

  it("a refusal from the native side is shown, and the list is read again", async () => {
    const api = { ...fake(incident), trash: vi.fn(async () => Promise.reject("running")) };
    show(api);
    fireEvent.click((await screen.findAllByRole("button", { name: "Mover a la papelera" }))[0]!);
    expect((await screen.findByRole("alert")).textContent).toBe("Esa es la copia que está abierta; no la toco.");
    await waitFor(() => expect(api.report).toHaveBeenCalledTimes(2));

    cleanup();
    const odd = { ...fake(incident), useThis: vi.fn(async () => Promise.reject("EACCES: permission denied")) };
    show(odd);
    fireEvent.click(await screen.findByRole("button", { name: "Usar esta copia" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No pude hacerlo. Inténtalo otra vez.");
    expect(screen.getByText("EACCES: permission denied")).toBeTruthy();

    for (const [code, text] of [
      ["not_listed", "Esa copia ya no está abierta."],
      ["still_running", "Sigue abierta: ciérrala desde su propio ícono en la barra."],
    ] as const) {
      cleanup();
      const closing = { ...fake(incident), close: vi.fn(async () => Promise.reject(code)) };
      show(closing);
      fireEvent.click(await screen.findByRole("button", { name: "Cerrar la otra copia" }));
      expect((await screen.findByRole("alert")).textContent).toBe(text);
    }
    cleanup();
    const unset = { ...fake(incident), useThis: vi.fn(async () => Promise.reject("handler_not_set")) };
    show(unset);
    fireEvent.click(await screen.findByRole("button", { name: "Usar esta copia" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/sigue abriendo los enlaces chalito:\/\//);
  });

  it("reads the list again when the panel comes back into view", async () => {
    const api = fake(clean);
    api.report.mockResolvedValueOnce(clean).mockResolvedValueOnce(incident);
    show(api);
    await act(async () => {});
    expect(screen.queryByText("Revisa las copias de Chalito")).toBeNull();
    window.dispatchEvent(new Event("focus"));
    await screen.findByText("Revisa las copias de Chalito");
  });

  it("keeps the buttons disabled while an action runs, so a double click sends one call", async () => {
    let finish: (r: CopiesReport) => void = () => {};
    const api = { ...fake(incident), trash: vi.fn(() => new Promise<CopiesReport>((res) => (finish = res))) };
    show(api);
    const [first] = await screen.findAllByRole("button", { name: "Mover a la papelera" });
    fireEvent.click(first!);
    fireEvent.click(first!);
    expect(api.trash).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Usar esta copia" }).hasAttribute("disabled")).toBe(true);
    await act(async () => finish(clean));
  });
});

describe("the copies commands (Tauri)", () => {
  it("each action is its own panel command with its argument", async () => {
    const calls: unknown[] = [];
    const api = invokeCopies(async <T,>(cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      return clean as T;
    });
    await api.report();
    await api.useThis();
    await api.trash(TEST_COPY);
    await api.close(4242);
    expect(calls).toEqual([
      ["copies_report", {}],
      ["copies_use_this", {}],
      ["copies_trash", { path: TEST_COPY }],
      ["copies_close", { pid: 4242 }],
    ]);
  });

  it("only a mismatch, a gone target, a copy or an instance counts as found", () => {
    expect(anythingFound(clean)).toBe(false);
    expect(anythingFound({ ...clean, autostart: { state: "none" }, handler: { state: "none" } })).toBe(false);
    expect(anythingFound({ ...clean, autostart: { state: "gone", path: "/x" } })).toBe(true);
    expect(anythingFound({ ...clean, handler: { state: "other", path: "/x" } })).toBe(true);
    expect(anythingFound({ ...clean, copies: incident.copies })).toBe(true);
    expect(anythingFound({ ...clean, instances: incident.instances })).toBe(true);
  });
});
