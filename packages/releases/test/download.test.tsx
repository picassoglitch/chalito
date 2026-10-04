import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import es from "../messages/es.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
import { detectPlatform } from "../src/detect.js";
import { DownloadPanel, fetchManifest } from "../src/download.js";
import type { ReleaseManifest } from "../src/manifest.js";

afterEach(cleanup);

const t = (cat: unknown) => (key: string, values?: Record<string, string | number>) => {
  let node: unknown = cat;
  for (const p of key.split(".")) node = (node as Record<string, unknown>)?.[p];
  if (typeof node !== "string") throw new Error(`missing ${key}`);
  return node.replace(/\{(\w+)\}/g, (_, k: string) => String(values?.[k]));
};

const H = "b".repeat(64);
const M: ReleaseManifest = {
  version: "1.2.0",
  notes: "",
  pub_date: "2026-10-20T12:00:00Z",
  platforms: {},
  downloads: {
    windows: [
      { kind: "nsis", name: "Chalito_1.2.0_x64-setup.exe", url: "https://signed/win", size: 9_437_184, sha256: H },
    ],
    macos: [
      { kind: "dmg", name: "Chalito_1.2.0_universal.dmg", url: "https://signed/mac", size: 20_971_520, sha256: H },
    ],
    linux: [
      { kind: "appimage", name: "Chalito.AppImage", url: "https://signed/ai", size: 1, sha256: H },
      { kind: "deb", name: "Chalito.deb", url: "https://signed/deb", size: 1, sha256: H },
    ],
  },
  unsigned: { windows: true, macos: false, linux: false },
};

const UA = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/143.0",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36",
};

describe("platform detection", () => {
  it.each([
    [{ userAgent: UA.windows }, "windows"],
    [{ userAgent: UA.mac }, "macos"],
    [{ userAgent: UA.linux }, "linux"],
    [{ userAgent: UA.iphone }, "ios"],
    [{ userAgent: UA.android }, "android"],
    [{ userAgent: UA.mac, platform: "MacIntel", maxTouchPoints: 5 }, "ios"], // iPadOS
    [{ userAgent: "x", userAgentData: { platform: "Windows" } }, "windows"],
    [{ userAgent: "x", userAgentData: { platform: "Chrome OS" } }, "linux"],
    [{}, "unknown"],
    [undefined, "unknown"],
  ] as const)("%o → %s", (nav, os) => expect(detectPlatform(nav)).toBe(os));
});

describe("/descargar panel", () => {
  it("offers the detected OS first, with sizes, checksums and the SmartScreen note on Windows", () => {
    const { container } = render(<DownloadPanel manifest={M} t={t(es)} navigator={{ userAgent: UA.windows }} />);
    expect(container.querySelector("[data-download-os]")?.getAttribute("data-download-os")).toBe("windows");
    expect(screen.getByText("Detectamos Windows.")).toBeTruthy();
    const link = screen.getByText("Instalador (.exe)") as HTMLAnchorElement;
    expect(link.href).toBe("https://signed/win");
    expect(screen.getByText(/9\.0 MB/)).toBeTruthy();
    expect(screen.getByText(H)).toBeTruthy();
    expect(container.querySelector("[data-unsigned]")).not.toBeNull();
    expect(screen.getByText(/SmartScreen/)).toBeTruthy();
  });

  it("the manual override switches OS; a signed build shows no unsigned warning", () => {
    const { container } = render(<DownloadPanel manifest={M} t={t(en)} navigator={{ userAgent: UA.windows }} />);
    fireEvent.click(screen.getByRole("radio", { name: "macOS" }));
    expect(container.querySelector("[data-download-os]")?.getAttribute("data-download-os")).toBe("macos");
    expect(screen.getByRole("radio", { name: "macOS" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Disk image/)).toBeTruthy();
    expect(container.querySelector("[data-unsigned]")).toBeNull();
    expect(screen.queryByText(/SmartScreen/)).toBeNull();
  });

  it("phones get a note and still see the desktop choices", () => {
    render(<DownloadPanel manifest={M} t={t(en)} navigator={{ userAgent: UA.iphone }} />);
    expect(screen.getByText(/On your phone, use the web app/)).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("loading and no release yet", () => {
    render(<DownloadPanel manifest={undefined} t={t(en)} />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    cleanup();
    render(<DownloadPanel manifest={null} t={t(en)} />);
    expect(screen.getByRole("status").textContent).toBe("Downloads aren't available yet.");
  });

  it("fetchManifest reads the api's signed manifest and rejects junk", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(M)));
    expect(await fetchManifest("https://api.example/", "stable", ok as unknown as typeof fetch)).toEqual(M);
    expect(ok).toHaveBeenCalledWith("https://api.example/releases/stable/latest.json", { credentials: "omit" });
    const junk = vi.fn(async () => new Response(JSON.stringify({ nope: 1 })));
    expect(await fetchManifest("https://api.example", "stable", junk as unknown as typeof fetch)).toBeNull();
    const missing = vi.fn(async () => new Response("", { status: 404 }));
    expect(await fetchManifest("https://api.example", "stable", missing as unknown as typeof fetch)).toBeNull();
  });

  it("es and en catalogs have the same keys", () => {
    const keys = (o: unknown, p = ""): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        typeof v === "object" && v ? keys(v, `${p}${k}.`) : [`${p}${k}`],
      );
    expect(keys(en).sort()).toEqual(keys(es).sort());
  });
});
