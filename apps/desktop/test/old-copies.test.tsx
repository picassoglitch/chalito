import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import {
  anythingFound,
  copyLabel,
  invokeCopies,
  type CopiesApi,
  type CopiesReport,
  type OldCopy,
} from "../src/lib/copies.js";
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
  installs: [],
  placement: "ok",
};

/** The owner's machine on 2026-10-25. */
const incident: CopiesReport = {
  ...clean,
  autostart: { state: "other", path: TEST_COPY },
  copies: [
    { path: TEST_COPY, version: "0.1.0-beta.2", bytes: 201456120, kind: "appimage" },
    { path: "/home/ana/Applications/chalito/Chalito.beta2.AppImage", version: null, bytes: 1, kind: "appimage" },
  ],
  instances: [{ pid: 4242, kind: "desktop", path: TEST_COPY }],
};

const fake = (first: CopiesReport, after: CopiesReport = clean) => ({
  report: vi.fn(async () => first),
  useThis: vi.fn(async () => after),
  trash: vi.fn(async (_path: string) => after),
  close: vi.fn(async (_pid: number) => after),
  reveal: vi.fn(async (_path: string) => after),
  uninstall: vi.fn(async (_id: string) => after),
  showApplications: vi.fn(async () => after),
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

const WIN_RUNNING = "C:\\Users\\Ana\\AppData\\Local\\Chalito\\chalito-desktop.exe";
const SETUP = "C:\\Users\\Ana\\Downloads\\UNSIGNED_Chalito_0.1.0-beta.2_x64-setup.exe";

/** Windows: a per-machine install next to the per-user one that runs, and a leftover installer. */
const windows: CopiesReport = {
  ...clean,
  running: WIN_RUNNING,
  handler: { state: "other", path: "C:\\Program Files\\Chalito\\chalito-desktop.exe" },
  installs: [{ id: "HKLM\\Chalito", scope: "machine", location: "C:\\Program Files\\Chalito", version: "0.1.0" }],
  copies: [{ path: SETUP, version: "0.1.0-beta.2", bytes: 9, kind: "installer" }],
};

const APP = "/Volumes/Chalito 0.2.0/Chalito.app";
const OLD_APP = "/Users/ana/Downloads/Chalito 2.app";

/** macOS: opened from the DMG, with another bundle and a .dmg in Downloads. */
const mac: CopiesReport = {
  ...clean,
  running: APP,
  autostart: { state: "other", path: `${OLD_APP}/Contents/MacOS/chalito-desktop` },
  placement: "dmg",
  copies: [
    { path: OLD_APP, version: "0.1.0", bytes: 0, kind: "app" },
    { path: "/Users/ana/Downloads/Chalito_0.2.0_universal.dmg", version: "0.2.0", bytes: 9, kind: "dmg" },
  ],
};

describe("other copies on Windows and macOS (panel notice)", () => {
  it("Windows: lists the other install with Desinstalar and the installer with trash and folder", async () => {
    const api = fake(windows, windows);
    show(api);
    await screen.findByText("Chalito 0.1.0 instalado para todos los usuarios: C:\\Program Files\\Chalito", {
      exact: false,
    });
    expect(screen.getByText(/Instalador descargado \(versión 0\.1\.0-beta\.2\)/)).toBeTruthy();
    expect(screen.getByText(/Se abre el desinstalador de esa copia/)).toBeTruthy();
    expect(api.uninstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Desinstalar" }));
    await waitFor(() => expect(api.uninstall).toHaveBeenCalledWith("HKLM\\Chalito"));
    await screen.findByText("Abrí el desinstalador de esa copia. Sigue sus pasos.");

    fireEvent.click(screen.getByRole("button", { name: "Abrir carpeta" }));
    await waitFor(() => expect(api.reveal).toHaveBeenCalledWith(SETUP));
    fireEvent.click(screen.getByRole("button", { name: "Mover a la papelera" }));
    await waitFor(() => expect(api.trash).toHaveBeenCalledWith(SETUP));
    fireEvent.click(screen.getByRole("button", { name: "Usar esta copia" }));
    await waitFor(() => expect(api.useThis).toHaveBeenCalledTimes(1));
  });

  it("Windows: an install without version or folder still reads, in English too", async () => {
    show(fake({ ...clean, installs: [{ id: "HKCU\\Chalito", scope: "user", location: null, version: null }] }), "en");
    await screen.findByText("Chalito installed for your user only: a folder I don't know", { exact: false });
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeTruthy();
  });

  it("Windows: no Recycle Bin on that drive and an HKLM startup entry are explained", async () => {
    for (const [code, text] of [
      ["no_trash", /Esa unidad no tiene papelera/],
      ["autostart_not_set", /una entrada de inicio para todos los usuarios/],
    ] as const) {
      cleanup();
      const api = {
        ...fake(windows),
        trash: vi.fn(async () => Promise.reject(code)),
        useThis: vi.fn(async () => Promise.reject(code)),
      };
      show(api);
      const button = code === "no_trash" ? "Mover a la papelera" : "Usar esta copia";
      fireEvent.click(await screen.findByRole("button", { name: button }));
      expect((await screen.findByRole("alert")).textContent).toMatch(text);
    }
  });

  it("macOS: from the DMG it explains the move, offers Mover a Aplicaciones and holds back Usar esta copia", async () => {
    const api = fake(mac, mac);
    show(api);
    await screen.findByText(/se está abriendo desde el disco de instalación \(\.dmg\)/);
    expect(screen.getByText(/Arrastra Chalito a la carpeta Aplicaciones/)).toBeTruthy();
    expect(screen.getByText(/Otra copia de la app \(versión 0\.1\.0\)/)).toBeTruthy();
    expect(screen.getByText(/Imagen de disco descargada \(versión 0\.2\.0\)/)).toBeTruthy();
    expect(screen.getByText(/Al encender la computadora se abre otra copia/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Usar esta copia" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Mover a la papelera" })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Mover a Aplicaciones" }));
    await waitFor(() => expect(api.showApplications).toHaveBeenCalledTimes(1));
    await screen.findByText(/Abrí Aplicaciones/);
    fireEvent.click(screen.getAllByRole("button", { name: "Mover a la papelera" })[0]!);
    await waitFor(() => expect(api.trash).toHaveBeenCalledWith(OLD_APP));
  });

  it("macOS: translocated, in English; once moved, Usar esta copia comes back", async () => {
    show(fake({ ...mac, placement: "translocated", copies: [] }), "en");
    await screen.findByText(/macOS opened Chalito from a temporary location/);
    expect(screen.getByRole("button", { name: "Move to Applications" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this copy" })).toBeNull();

    cleanup();
    show(fake({ ...mac, placement: "ok", copies: [] }), "en");
    await screen.findByRole("button", { name: "Use this copy" });
    expect(screen.queryByRole("button", { name: "Move to Applications" })).toBeNull();
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
    await api.reveal(SETUP);
    await api.uninstall("HKLM\\Chalito");
    await api.showApplications();
    expect(calls).toEqual([
      ["copies_report", {}],
      ["copies_use_this", {}],
      ["copies_trash", { path: TEST_COPY }],
      ["copies_close", { pid: 4242 }],
      ["copies_reveal", { path: SETUP }],
      ["copies_uninstall", { id: "HKLM\\Chalito" }],
      ["copies_show_applications", {}],
    ]);
  });

  it("only a mismatch, a gone target, a copy or an instance counts as found", () => {
    expect(anythingFound(clean)).toBe(false);
    expect(anythingFound({ ...clean, autostart: { state: "none" }, handler: { state: "none" } })).toBe(false);
    expect(anythingFound({ ...clean, autostart: { state: "gone", path: "/x" } })).toBe(true);
    expect(anythingFound({ ...clean, handler: { state: "other", path: "/x" } })).toBe(true);
    expect(anythingFound({ ...clean, copies: incident.copies })).toBe(true);
    expect(anythingFound({ ...clean, instances: incident.instances })).toBe(true);
    expect(anythingFound({ ...clean, installs: windows.installs })).toBe(true);
    expect(anythingFound({ ...clean, placement: "translocated" })).toBe(true);
  });

  it("each kind of copy has its own wording", () => {
    const c = (kind: OldCopy["kind"], version: string | null) => copyLabel({ path: "/x", version, bytes: 0, kind });
    expect(c("appimage", null)).toBe("copies.old");
    expect(c("appimage", "1.0")).toBe("copies.oldVersion");
    expect(c("installer", null)).toBe("copies.kind.installer");
    expect(c("dmg", "1.0")).toBe("copies.kind.dmgVersion");
    expect(c("app", "1.0")).toBe("copies.kind.appVersion");
  });
});
