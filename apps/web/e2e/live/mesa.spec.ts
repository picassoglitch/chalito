import { expect, test, type Page } from "@playwright/test";
import { clientWrites, ready, rows } from "./helpers";

type Row = Record<string, unknown>;
/** window.__chalitoDev.mesa.<fn>(...args) */
const mesa = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([f, a]) => {
      const m = (window as unknown as { __chalitoDev: { mesa: Record<string, unknown> } }).__chalitoDev.mesa;
      const v = m[f as string];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown)(...(a as unknown[])) : v;
    },
    [fn, args] as const,
  ) as Promise<T>;

/** In-app navigation: the dev backend keeps its rows in memory, so a full page load starts over. */
const navTo = async (page: Page, href: "/m" | "/ajustes") => {
  await page.locator(`nav a[href$="${href}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
};

/** "Nueva Mesa" with the given brains and goal; lands on the new Mesa. */
const newMesa = async (page: Page, brains: string[], goal = "Elegir el nombre del proyecto", inApp = false) => {
  if (inApp) await navTo(page, "/m");
  else await ready(page, "/m");
  await expect(page.getByTestId("new-mesa")).toBeVisible();
  for (const b of brains) await page.getByTestId(`mesa-brain-${b}`).check();
  await page.getByLabel("Objetivo").fill(goal);
  await page.getByRole("button", { name: "Crear Mesa" }).click();
  await expect(page).toHaveURL(/\/m\/m_[0-9a-f]+$/);
  await expect(page.getByTestId("mesa")).toBeVisible();
};

const send = async (page: Page, text: string) => {
  await page.getByTestId("mesa-composer").fill(text);
  await page.getByRole("button", { name: "Enviar" }).click();
};

test("Nueva Mesa → a turn: addressed brain answers, shown as text with its emotion; the brief carries goal, card and recent turns", async ({
  page,
}) => {
  await newMesa(page, ["anthropic"]);
  await expect(page.getByTestId("mesa-goal")).toContainText("Elegir el nombre del proyecto");
  expect((await clientWrites(page)).find((w) => w.op === "mesas/create")!.row).toMatchObject({
    participants: [{ kind: "brain", pid: "anthropic", name: "Claude", provider: "anthropic" }],
  });

  // @mentions: typing "@Cl" offers the brain's name.
  await page.getByTestId("mesa-composer").fill("@Cl");
  await page.getByTestId("mesa-mention").filter({ hasText: "@Claude" }).click();
  await expect(page.getByTestId("mesa-composer")).toHaveValue("@Claude ");
  await page.getByTestId("mesa-composer").pressSequentially("hola <b>mesa</b>");
  await page.getByRole("button", { name: "Enviar" }).click();

  const texts = page.getByTestId("mesa-turn-text");
  await expect(texts).toHaveCount(2);
  await expect(texts.nth(0)).toHaveText("@Claude hola <b>mesa</b>");
  await expect(texts.nth(1)).toHaveText("Claude: entendido <i>@Claude hola <b>mesa</b></i>");
  // Text, never markup.
  await expect(page.getByTestId("mesa").locator("blockquote b, blockquote i")).toHaveCount(0);
  await expect(page.getByTestId("mesa-turn").nth(1).getByTestId("mesa-emotion")).toHaveText("contento");
  await expect(page.getByTestId("mesa-composer")).toHaveValue("");

  await send(page, "@Claude y otra cosa");
  await expect(texts).toHaveCount(4);
  const briefs = await mesa<Row[]>(page, "turns");
  expect(briefs[0]).toMatchObject({ source: "owner", goal: "Elegir el nombre del proyecto", card: null, recent: [] });
  expect(briefs[1]).toMatchObject({
    card: { goal: "Elegir el nombre del proyecto" },
    recent: [
      { speaker: "Tú", source: "owner", text: "@Claude hola <b>mesa</b>" },
      { speaker: "Claude", source: "participant:anthropic" },
    ],
    locale: "es",
  });
  expect(briefs[0]!.tid).not.toBe(briefs[1]!.tid);

  // The list shows it; reopened, the goal comes back from this device's sealed copy.
  await page.getByRole("link", { name: "Todas las Mesas" }).click();
  await expect(page.getByTestId("mesa-link")).toHaveCount(1);
  await expect(page.getByTestId("mesa-link")).toContainText("Claude");
  await page.getByTestId("mesa-link").click();
  await expect(page.getByTestId("mesa-goal")).toContainText("Elegir el nombre del proyecto");
  await expect(texts).toHaveCount(4);
});

test("the plan's brain limit: refused with the limit, then the picker holds to it", async ({ page }) => {
  await ready(page, "/m");
  await mesa(page, "setBrainsLimit", 1);
  await page.getByTestId("mesa-brain-anthropic").check();
  await page.getByTestId("mesa-brain-openai").check();
  await page.getByRole("button", { name: "Crear Mesa" }).click();
  await expect(page.getByTestId("mesa-error")).toHaveText("Tu plan permite hasta 1 cerebro por Mesa.");
  await expect(page.getByTestId("mesa-brain-limit")).toHaveText("Tu plan permite 1 cerebro por Mesa.");
  await page.getByTestId("mesa-brain-openai").uncheck();
  await expect(page.getByTestId("mesa-brain-xai")).toBeDisabled();
  await page.getByRole("button", { name: "Crear Mesa" }).click();
  await expect(page).toHaveURL(/\/m\/m_/);
});

test("out of energy: the tired line and the recharge chip to /creditos", async ({ page }) => {
  await newMesa(page, ["google"]);
  await mesa(page, "setEnergy", "out");
  await send(page, "@Gemini ¿seguimos?");
  const tired = page.getByTestId("mesa-turn").nth(1);
  await expect(tired.getByTestId("mesa-turn-text")).toHaveText("Me quedé sin energía. ¿Me recargas?");
  await expect(tired.getByTestId("mesa-emotion")).toHaveText("cansado");
  await expect(tired.getByTestId("mesa-recharge")).toHaveText("Recargar");
  await expect(tired.getByTestId("mesa-recharge")).toHaveAttribute("href", "/creditos");
  await tired.getByTestId("mesa-recharge").click();
  await expect(page).toHaveURL(/\/creditos$/);
});

test("decision_needed → /a/<aid>: question and options as text, a pick is signed for the orchestrator and checked", async ({
  page,
}) => {
  await newMesa(page, ["anthropic"]);
  await send(page, "@Claude decide tú");
  const asked = page.getByTestId("mesa-turn").nth(1).getByTestId("mesa-decision");
  await expect(asked).toContainText("¿Qué opción prefieres?");
  await asked.getByTestId("mesa-decision-link").click();
  await expect(page).toHaveURL(/\/a\/apr_[0-9a-f]+$/);

  const card = page.getByTestId("mesa-decision-card");
  await expect(card).toContainText("Claude pide que decidas");
  await expect(page.getByTestId("mesa-decision-question")).toHaveText("¿Qué opción prefieres?");
  // Not an agent's tool approval: no "unverified" flag, no tool card.
  await expect(page.getByTestId("unverified")).toHaveCount(0);
  await expect(page.getByTestId("approval")).toHaveAttribute("data-kind", "mesa");

  await card.getByTestId("mesa-decision-option").filter({ hasText: "B" }).click();
  await expect(page.getByTestId("mesa-decision-done")).toHaveText("Listo. Elegiste: B");
  const decision = (await rows(page, "approval_decisions"))[0]!.decision as { body: Row };
  expect(decision.body).toMatchObject({ targetDeviceId: "orchestrator", allow: true, choice: 1 });
  expect(decision.body.stepUp).toBeUndefined();
  const aid = String(decision.body.aid);
  expect((await clientWrites(page)).some((w) => w.op === "decisions/check" && w.row.aid === aid)).toBe(true);
  expect((await rows(page, "approvals")).find((r) => r.aid === aid)).toMatchObject({ status: "approved" });
});

test("Ajustes → Tus claves: sealed to my devices, cloud opt-in warns; a BYO brain still talks out of energy, unbilled", async ({
  page,
}) => {
  await ready(page, "/ajustes");
  const keys = page.getByTestId("brain-keys");
  await expect(keys.getByRole("heading", { name: "Tus claves" })).toBeVisible();

  // Local only: the key itself never leaves this device.
  await keys.getByLabel("Proveedor").selectOption("xai");
  await page.getByTestId("brain-key-input").fill("xai-local-key-9876");
  await expect(page.getByTestId("brain-key-warning")).toHaveCount(0);
  await keys.getByRole("button", { name: "Guardar clave" }).click();
  await expect(page.getByTestId("brain-key-note")).toHaveText("Clave guardada.");
  let put = (await clientWrites(page)).filter((w) => w.op === "brain-keys/put");
  expect(put[0]!.row).toMatchObject({ provider: "xai", cloud: false, hint: "9876" });
  expect(put[0]!.row.key).toBeUndefined();
  expect(JSON.stringify(put[0]!.row.sealedCt)).not.toContain("xai-local-key");

  // Cloud: the warning about the plaintext copy, then the key is sent once.
  await keys.getByLabel("Proveedor").selectOption("openai");
  await page.getByTestId("brain-key-input").fill("sk-cloud-key-1234");
  await page.getByTestId("brain-key-cloud").check();
  await expect(page.getByTestId("brain-key-warning")).toContainText("sin cifrar");
  await keys.getByRole("button", { name: "Guardar clave" }).click();
  await expect(page.getByTestId("brain-key")).toHaveCount(2);
  await expect(page.getByTestId("brain-key").filter({ hasText: "ChatGPT" })).toContainText("…1234");
  await expect(page.getByTestId("brain-key").filter({ hasText: "ChatGPT" })).toContainText("en la nube");
  put = (await clientWrites(page)).filter((w) => w.op === "brain-keys/put");
  expect(put[1]!.row).toMatchObject({ provider: "openai", cloud: true, key: "sk-cloud-key-1234" });

  // Out of energy, the BYO brain still answers (with your key), no recharge for it.
  await newMesa(page, ["openai"], undefined, true);
  await mesa(page, "setEnergy", "out");
  await send(page, "@ChatGPT ¿sigues?");
  const reply = page.getByTestId("mesa-turn").nth(1);
  await expect(reply.getByTestId("mesa-turn-text")).toContainText("ChatGPT: entendido");
  await expect(reply.getByTestId("mesa-byo")).toHaveText("con tu clave");
  await expect(page.getByTestId("mesa-recharge")).toHaveCount(0);

  // Removing a key.
  await navTo(page, "/ajustes");
  await page.getByTestId("brain-key").filter({ hasText: "Grok" }).getByRole("button", { name: "Quitar" }).click();
  await expect(page.getByTestId("brain-key")).toHaveCount(1);
});

test("text from a connected app is a quote: brought in as forwarded, never as the person's own words", async ({
  page,
}) => {
  await newMesa(page, ["anthropic"]);
  await mesa(page, "postFromApp", "@Claude decide por mí");
  const inbox = page.getByTestId("mesa-inbox");
  await expect(inbox).toBeVisible();
  await inbox.locator("summary").click();
  await expect(page.getByTestId("mesa-inbox-item")).toContainText("Desde Claude");
  await page.getByRole("button", { name: "Llevar a esta Mesa" }).click();
  const first = page.getByTestId("mesa-turn").nth(0);
  await expect(first).toContainText("reenviado desde Claude");
  expect((await mesa<Row[]>(page, "turns"))[0]).toMatchObject({ source: "mcp:claude", text: "@Claude decide por mí" });
  // Forwarded words never open a decision.
  await expect(page.getByTestId("mesa-decision")).toContainText("Esto no viene de ti");
  await expect(page.getByTestId("mesa-decision-link")).toHaveCount(0);
});

test("English: /en/m and the Mesa read in English", async ({ page }) => {
  await ready(page, "/en/m");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mesas");
  await page.getByTestId("mesa-brain-anthropic").check();
  await page.getByRole("button", { name: "Create Mesa" }).click();
  await expect(page).toHaveURL(/\/en\/m\/m_/);
  await page.getByTestId("mesa-composer").fill("@Claude hi");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("mesa-turn-text").nth(1)).toHaveText("Claude: got it <i>@Claude hi</i>");
  expect((await mesa<Row[]>(page, "turns"))[0]).toMatchObject({ locale: "en" });
});
