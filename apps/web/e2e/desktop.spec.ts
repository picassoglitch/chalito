import { API, expect, test } from "./fixtures";

const STATE = "Abc_Def-123456789012345678901234567890abcde".slice(0, 43);

test("bad state or redirect_uri goes home and sets nothing", async ({ page, context }) => {
  for (const q of [
    `state=short&redirect_uri=${encodeURIComponent("chalito://auth/sso")}`,
    `state=${STATE}&redirect_uri=${encodeURIComponent("https://evil.example/auth/sso")}`,
    `state=${STATE}&redirect_uri=${encodeURIComponent("http://127.0.0.1:80/auth/sso")}`,
    `state=${STATE}`,
  ]) {
    await page.goto(`/auth/desktop?${q}`);
    await expect(page).toHaveURL(/127\.0\.0\.1:3100\/$/);
  }
  expect((await context.cookies()).find((c) => c.name === "chalito_desktop")).toBeUndefined();
});

test("desktop sign-in: the hub's token goes to the app via 'Abrir Chalito', never exchanged in the browser", async ({
  page,
  context,
}) => {
  let exchanged = 0;
  await page.route(
    `${API}/sso/exchange`,
    (r) => ((exchanged += 1), r.fulfill({ json: { customToken: "x", owner: "u" } })),
  );
  // page.request shares this context's cookies; a server redirect to the hub isn't routable in navigation.
  const start = await page.request.get(
    `/auth/desktop?state=${STATE}&redirect_uri=${encodeURIComponent("chalito://auth/sso")}`,
    {
      maxRedirects: 0,
    },
  );
  expect(start.status()).toBe(303);
  expect(start.headers().location).toBe("https://hub.example/auth/launch/chalito");
  const cookie = (await context.cookies()).find((c) => c.name === "chalito_desktop");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });

  await page.goto("/auth/sso?token=hub.launch.token&next=%2Fa%2Fapr_1");
  const open = page.getByRole("link", { name: "Abrir Chalito" });
  await expect(open).toHaveAttribute(
    "href",
    `chalito://auth/sso?token=hub.launch.token&state=${STATE}&next=%2Fa%2Fapr_1`,
  );
  expect(exchanged).toBe(0);
  expect((await context.cookies()).find((c) => c.name === "chalito_desktop")).toBeUndefined();
  await expect(page).not.toHaveURL(/hub\.launch\.token/);
});

test("loopback redirect works too, and a normal web sign-in afterwards is unaffected", async ({ page }) => {
  await page.request.get(
    `/auth/desktop?state=${STATE}&redirect_uri=${encodeURIComponent("http://127.0.0.1:53682/auth/sso")}`,
    {
      maxRedirects: 0,
    },
  );
  await page.goto("/auth/sso?token=t1");
  await expect(page.getByRole("link", { name: "Abrir Chalito" })).toHaveAttribute(
    "href",
    `http://127.0.0.1:53682/auth/sso?token=t1&state=${STATE}`,
  );
  // The cookie was consumed: the next /auth/sso is an ordinary web sign-in (exchange called).
  let exchanged = 0;
  await page.route(
    `${API}/sso/exchange`,
    (r) => ((exchanged += 1), r.fulfill({ status: 401, json: { error: "bad_signature" } })),
  );
  await page.goto("/auth/sso?token=t2");
  await expect(page.locator("main [role=alert]")).toContainText("No pudimos abrir tu sesión");
  expect(exchanged).toBe(1);
});

test("/auth/desktop answers with no-referrer and noindex", async ({ request }) => {
  const res = await request.get(
    `/auth/desktop?state=${STATE}&redirect_uri=${encodeURIComponent("chalito://auth/sso")}`,
    { maxRedirects: 0 },
  );
  expect(res.status()).toBe(303);
  expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  expect(res.headers()["x-robots-tag"]).toContain("noindex");
});
