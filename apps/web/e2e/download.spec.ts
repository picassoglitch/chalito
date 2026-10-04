import { API, expect, test } from "./fixtures";

const sha = "a".repeat(64);
const MANIFEST = {
  version: "1.2.0",
  notes: "",
  pub_date: "2026-10-04T00:00:00Z",
  platforms: {},
  downloads: {
    windows: [
      {
        kind: "nsis",
        name: "Chalito_1.2.0_x64-setup.exe",
        url: "https://storage.example/signed/win",
        size: 52_428_800,
        sha256: sha,
      },
    ],
    macos: [
      {
        kind: "dmg",
        name: "Chalito_1.2.0_universal.dmg",
        url: "https://storage.example/signed/mac",
        size: 73_400_320,
        sha256: sha,
      },
    ],
    linux: [
      {
        kind: "appimage",
        name: "Chalito_1.2.0_amd64.AppImage",
        url: "https://storage.example/signed/appimage",
        size: 94_371_840,
        sha256: sha,
      },
      // An unsigned bucket path (or any non-https link) is never offered.
      {
        kind: "deb",
        name: "Chalito_1.2.0_amd64.deb",
        url: "stable/1.2.0/Chalito_1.2.0_amd64.deb",
        size: 1,
        sha256: sha,
      },
    ],
  },
  unsigned: { macos: true },
};

test("/descargar offers the installers from the api's signed manifest, with a manual OS switch", async ({ page }) => {
  await page.route(`${API}/releases/stable/latest.json`, (r) => r.fulfill({ json: MANIFEST }));
  await page.goto("/descargar");
  const panel = page.getByTestId("download");
  await expect(panel.getByRole("heading", { level: 1 })).toHaveText("Descarga Chalito para tu computadora");
  await expect(panel).toContainText("Versión 1.2.0");
  await panel.getByRole("radio", { name: "Linux" }).click();
  await expect(panel.getByRole("link", { name: "AppImage (cualquier distribución)" })).toHaveAttribute(
    "href",
    "https://storage.example/signed/appimage",
  );
  await expect(panel.locator("[data-kind=deb]")).toHaveCount(0);
  await panel.getByRole("radio", { name: "macOS" }).click();
  await expect(panel.locator("[data-unsigned]")).toBeVisible();
  await panel.getByRole("radio", { name: "Windows" }).click();
  await expect(panel).toContainText("SmartScreen");
  await expect(panel).toContainText(sha);
});

test("no release yet: says so (EN at /en/download)", async ({ page }) => {
  await page.route(`${API}/releases/stable/latest.json`, (r) =>
    r.fulfill({ status: 404, json: { error: "not_found" } }),
  );
  await page.goto("/en/download");
  await expect(page.getByTestId("download")).toContainText("Downloads aren't available yet.");
});
