import { expect, test } from "./fixtures";

/** Review R-M12: an enforced, nonce-based CSP on every page (production build). */
test("pages send a strict, per-request CSP and every script carries its nonce", async ({ page, request }) => {
  const a = await request.get("/");
  const b = await request.get("/en/settings");
  const csp = a.headers()["content-security-policy"];
  expect(csp).toBeTruthy();
  for (const d of [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "'strict-dynamic'",
    "connect-src 'self' http://127.0.0.1:54399 http://127.0.0.1:8799 ws://127.0.0.1:54399 https://storage.googleapis.com",
  ])
    expect(csp).toContain(d);
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).toContain("'wasm-unsafe-eval'");
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  const nonce = /'nonce-([^']+)'/.exec(csp!)![1]!;
  expect(/'nonce-([^']+)'/.exec(b.headers()["content-security-policy"]!)![1]).not.toBe(nonce);
  expect(a.headers()["strict-transport-security"]).toContain("max-age=");

  // The HTML's scripts all carry this response's nonce.
  const html = await a.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  expect(scripts.length).toBeGreaterThan(0);
  for (const s of scripts) expect(s).toContain(`nonce="${nonce}"`);

  // And the app actually runs under it: no violations while it boots and navigates.
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Ajustes" }).click();
  await expect(page).toHaveURL(/\/ajustes$/);
  await page.goto("/bienvenida");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(violations).toEqual([]);
});
