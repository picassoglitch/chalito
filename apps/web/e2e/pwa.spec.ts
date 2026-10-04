import { expect, test } from "./fixtures";

// Lighthouse's installability checks, asserted directly (the Lighthouse run itself is a manual check).
test("the manifest makes the app installable", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m).toMatchObject({ name: "Chalito", short_name: "Chalito", start_url: "/inicio", display: "standalone" });
  const sizes = (m.icons as { sizes: string; purpose: string }[]).map((i) => `${i.sizes}:${i.purpose}`);
  expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
  for (const i of m.icons as { src: string }[])
    expect((await request.get(i.src)).headers()["content-type"]).toBe("image/png");
});

test("the page links the manifest and registers the service worker", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe("http://127.0.0.1:3100/");
});
