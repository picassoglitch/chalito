// @vitest-environment node

// Conexiones search: the real SearchSection against the real agent handlers, a local stand-in registry
// (recorded responses) and a temp HOME; nothing here touches this machine's ~/.chalito or keychain.
import "./node-dom.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectionSearchHandlers, connectionsSearchFeature } from "../../agent/src/connections/ipc.js";
import { VerifiedConnectors } from "../../agent/src/connections/catalog.js";
import { shippedConnectors } from "../../agent/src/connections/shipped.js";
import { MemorySecretStore } from "../../agent/src/secrets.js";
import { TextProviders } from "../src/lib/i18n.js";
import { invokeConnectionsSearchIpc } from "../src/panel/connections/search-ipc.js";
import { SearchSection } from "../src/panel/connections/SearchSection.js";

const page = readFileSync(new URL("../../agent/test/fixtures/registry/search-github.json", import.meta.url), "utf8");
const servers = (JSON.parse(page) as { servers: { server: { name: string; version: string } }[] }).servers;

let registry: Server;
let base = "";
beforeAll(async () => {
  registry = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (b: string) => res.writeHead(200, { "content-type": "application/json" }).end(b);
    if (url.pathname === "/v0.1/servers") return send(page);
    const m = /^\/v0\.1\/servers\/([^/]+)\/versions\/([^/]+)$/.exec(url.pathname);
    const hit = m && servers.find((s) => s.server.name === decodeURIComponent(m[1]!));
    if (hit) return send(JSON.stringify(hit));
    if (url.pathname === "/oauth-mcp") return res.writeHead(401, { "www-authenticate": "Bearer" }).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => registry.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => registry.close(() => r())));

let home = "";
const realHome = process.env.HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chalito-conexiones-"));
  process.env.HOME = home;
});
afterEach(() => {
  cleanup();
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const mount = () => {
  const secrets = new MemorySecretStore();
  const audit: string[] = [];
  const handlers = connectionSearchHandlers(
    connectionsSearchFeature({
      verified: new VerifiedConnectors(shippedConnectors()),
      dir: join(home, ".chalito"), secrets, audit: (t) => audit.push(t), registry: { base } }),
  );
  const ipc = invokeConnectionsSearchIpc(async <T,>(_cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return (await handlers[args!.method as string]!(args!.params ?? undefined)) as T;
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  });
  render(
    <TextProviders locale="es">
      <SearchSection ipc={ipc} />
    </TextProviders>,
  );
  return { secrets, audit };
};

const card = (id: string) => document.querySelector<HTMLElement>(`[data-connector="${id}"]`)!;

describe("Conexiones → Buscar", () => {
  it("lists Verificado and Comunidad results; OAuth ones say Próximamente and can't be installed", async () => {
    mount();
    await waitFor(() => expect(card("github")).toBeTruthy(), { timeout: 3000 });
    expect(within(card("github")).getByText("Verificado")).toBeTruthy();
    expect(within(card("slack")).getByText("Próximamente")).toBeTruthy();
    expect(within(card("slack")).queryByRole("button", { name: "Instalar" })).toBeNull();
    expect(within(card("ai-smithery-smithery-ai-github")).getByText("Comunidad")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cargar más" })).toBeTruthy();
  });

  it("community install: one warning + one confirmation, token to the keychain, then listed as installed", async () => {
    const { secrets, audit } = mount();
    await waitFor(() => expect(card("ai-smithery-smithery-ai-github")).toBeTruthy(), { timeout: 3000 });
    fireEvent.click(within(card("ai-smithery-smithery-ai-github")).getByRole("button", { name: "Instalar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Chalito no ha revisado este servidor/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Entiendo, instalar" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // the token is required
    fireEvent.change(within(dialog).getByLabelText("Authorization"), { target: { value: "sk_test" } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(document.querySelector('[data-installed="ai-smithery-smithery-ai-github"]')).toBeTruthy(),
    );
    expect(await secrets.get("chalito.connector.ai-smithery-smithery-ai-github.token")).toBe("sk_test");
    const file = JSON.parse(readFileSync(join(home, ".chalito", "connectors.json"), "utf8"));
    expect(file.installed[0]).toMatchObject({ source: "community", confirmedWarning: true });
    expect(JSON.stringify(file)).not.toContain("sk_test");
    expect(audit).toEqual(["connector.installed"]);
    const quitar = within(document.querySelector<HTMLElement>("[data-installed]")!).getByRole("button", {
      name: "Quitar",
    }) as HTMLButtonElement;
    await waitFor(() => expect(quitar.disabled).toBe(false));
    fireEvent.click(quitar);
    await waitFor(() => expect(document.querySelector("[data-installed]")).toBeNull());
    expect(secrets.values.size).toBe(0);
  });

  it("while a dialog is open other Install buttons wait; cancel clears what was typed", async () => {
    mount();
    await waitFor(() => expect(card("linear")).toBeTruthy(), { timeout: 3000 });
    fireEvent.click(within(card("linear")).getByRole("button", { name: "Instalar" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Authorization"), { target: { value: "lin_secret" } });
    const other = within(card("github")).getByRole("button", { name: "Instalar" }) as HTMLButtonElement;
    expect(other.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(other.disabled).toBe(false));
    fireEvent.click(other);
    const next = await screen.findByRole("dialog");
    expect((within(next).getByLabelText("Authorization") as HTMLInputElement).value).toBe("");
  });

  it("verified install shows no unverified warning and a plain Instalar", async () => {
    mount();
    await waitFor(() => expect(card("linear")).toBeTruthy(), { timeout: 3000 });
    fireEvent.click(within(card("linear")).getByRole("button", { name: "Instalar" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("[data-unverified-warning]")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Instalar" })).toBeTruthy();
  });

  it("Agregar la tuya by URL: a server that wants OAuth is refused as Próximamente", async () => {
    mount();
    fireEvent.click(screen.getByText("Agregar la tuya"));
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Mía" } });
    fireEvent.change(screen.getByLabelText("URL del servidor (HTTPS)"), {
      target: { value: `http://localhost:${new URL(base).port}/oauth-mcp` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await waitFor(() => expect(document.querySelector('[data-error="held_oauth"]')).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
