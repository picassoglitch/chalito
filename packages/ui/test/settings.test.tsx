import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import es from "../messages/es.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
import {
  CompanionPicker,
  DEFAULT_SETTINGS,
  RosterAssetsProvider,
  SETTINGS,
  SHELLS,
  SettingsPanel,
  type CompanionId,
  type SettingKey,
  type SettingsValues,
} from "../src/index.js";
import { renderUi } from "./helpers.js";
import type { PhoneVerifier } from "../src/index.js";

/** Accepts code 123456 for any number. */
const mockVerifier = (): PhoneVerifier & { started: string[] } => {
  const started: string[] = [];
  return {
    started,
    start: async (e164, o) => (started.push(`${e164}:${o.channel}`), { ok: true }),
    check: async (_e164, code) => (code === "123456" ? { ok: true } : { ok: false, reason: "wrong_code" }),
  };
};
const VERIFIED = { e164: "+525512345678", verified: true };

afterEach(cleanup);

/** Every setting the brief lists (M5 "settings parity"). */
const REQUIRED: SettingKey[] = [
  "phone",
  "chargesAck",
  "whatsapp",
  "calls",
  "callBriefing",
  "quietHours",
  "avatar",
  "companionName",
  "privacyMode",
  "connections",
  "planCredits",
  "renderQuality",
];

const Panel = ({ shell, values = DEFAULT_SETTINGS }: { shell: (typeof SHELLS)[number]; values?: SettingsValues }) => (
  <SettingsPanel
    shell={shell}
    values={values}
    onChange={() => undefined}
    providerLabel={(p) => p}
    hubPlansUrl="https://hub.example/planes"
    phoneVerifier={mockVerifier()}
  />
);

describe("settings registry", () => {
  it("covers every setting the brief lists, once, and every SettingsValues key", () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...REQUIRED].sort());
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual([...REQUIRED].sort());
  });

  it.each(SHELLS.flatMap((shell) => (["es", "en"] as const).map((locale) => [shell, locale] as const)))(
    "parity: every registered setting renders in the %s shell (%s)",
    (shell, locale) => {
      const { container } = renderUi(<Panel shell={shell} />, locale);
      for (const s of SETTINGS) expect(container.querySelector(`[data-setting-key="${s.key}"]`), s.key).not.toBeNull();
      expect(container.querySelector(`[data-shell="${shell}"]`)).not.toBeNull();
    },
  );

  it("no message key contains '.' (next-intl reads dots as nesting)", () => {
    const bad = (o: unknown, path = ""): string[] =>
      typeof o === "object" && o
        ? Object.entries(o).flatMap(([k, v]) => [
            ...(k.includes(".") ? [`${path}${k}`] : []),
            ...bad(v, `${path}${k}/`),
          ])
        : [];
    expect([...bad(es), ...bad(en)]).toEqual([]);
  });

  it("es and en catalogs have the same keys", () => {
    const keys = (o: unknown, p = ""): string[] =>
      typeof o === "object" && o ? Object.entries(o).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k)) : [p];
    expect(keys(en).sort()).toEqual(keys(es).sort());
  });
});

describe("charges notice and opt-ins", () => {
  it("opt-ins need a verified phone and the charges acknowledgement", () => {
    renderUi(<Panel shell="web" />);
    for (const name of [/Avisos por WhatsApp/, /Llamadas/])
      expect(screen.getByRole("switch", { name }).hasAttribute("disabled")).toBe(true);
    cleanup();
    renderUi(<Panel shell="web" values={{ ...DEFAULT_SETTINGS, phone: VERIFIED }} />);
    expect(screen.getByRole("switch", { name: /Llamadas/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Entiendo que pueden aplicar cargos.")).toBeTruthy();
    cleanup();
    renderUi(<Panel shell="web" values={{ ...DEFAULT_SETTINGS, phone: VERIFIED, chargesAck: true }} />);
    expect(screen.getByRole("switch", { name: /Llamadas/ }).hasAttribute("disabled")).toBe(false);
  });

  it("shows 'Pueden aplicar cargos' / 'Charges may apply' up front, and again on each channel that's on", () => {
    renderUi(<Panel shell="web" />);
    expect(screen.getAllByTestId("charges-notice")).toHaveLength(1);
    cleanup();
    const on = { ...DEFAULT_SETTINGS, phone: VERIFIED, chargesAck: true, whatsapp: true };
    renderUi(<Panel shell="web" values={on} />);
    expect(screen.getAllByTestId("charges-notice").map((n) => n.textContent)).toEqual([
      "Pueden aplicar cargos.",
      "Pueden aplicar cargos.",
    ]);
    cleanup();
    renderUi(<Panel shell="desktop" values={{ ...on, whatsapp: false, calls: true }} />, "en");
    expect(screen.getAllByTestId("charges-notice")[0]!.textContent).toBe("Charges may apply.");
  });

  it("withdrawing the acknowledgement turns the paid channels off", () => {
    const changes: [string, unknown][] = [];
    renderUi(
      <SettingsPanel
        shell="web"
        values={{ ...DEFAULT_SETTINGS, phone: VERIFIED, chargesAck: true, calls: true }}
        onChange={(k, v) => changes.push([k, v])}
        providerLabel={(p) => p}
        hubPlansUrl="#"
        phoneVerifier={mockVerifier()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Entiendo que pueden aplicar cargos."));
    expect(changes).toEqual([
      ["chargesAck", false],
      ["whatsapp", false],
      ["calls", false],
    ]);
  });
});

describe("companion name", () => {
  it("shows the live credit line in the user's language once renamed", () => {
    const values = { ...DEFAULT_SETTINGS, companionName: { name: "Pepe", isRenamed: true } };
    renderUi(<Panel shell="web" values={values} />);
    expect(screen.getByTestId("companion-title").textContent).toBe("Pepe");
    expect(screen.getByTestId("credit-line").textContent).toContain("impulsado por Chalito Bot");
    cleanup();
    renderUi(<Panel shell="web" values={values} />, "en");
    expect(screen.getByTestId("credit-line").textContent).toContain("powered by Chalito Bot");
  });

  it("an un-renamed companion is just Chalito, without a credit line", () => {
    renderUi(<Panel shell="web" />);
    expect(screen.getByTestId("companion-title").textContent).toBe("Chalito");
    expect(screen.queryByTestId("credit-line")).toBeNull();
  });
});

describe("companion picker", () => {
  const picker = (
    value: CompanionId = "chalito",
    onChange: (c: string) => void = () => undefined,
    locale: "es" | "en" = "es",
  ) =>
    renderUi(
      <RosterAssetsProvider base="/roster">
        <CompanionPicker value={value} onChange={onChange} />
      </RosterAssetsProvider>,
      locale,
    );
  const radios = () => screen.getAllByRole("radio") as HTMLInputElement[];

  it("opens on the chosen companion's category, with lazy thumbnails", () => {
    picker();
    expect(screen.getByRole("button", { name: "Personas" }).getAttribute("aria-pressed")).toBe("true");
    expect(radios()).toHaveLength(20);
    expect(radios().find((r) => r.checked)?.value).toBe("chalito");
    const img = screen.getByRole("radiogroup").querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/roster/assets/chalito/thumb-128.webp");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(screen.getByTestId("companion-selected").textContent).toContain("Chalito");
  });

  it("switches category, shows everyone under Todos, and picks", () => {
    const picked: string[] = [];
    picker("chalito", (c) => picked.push(c));
    fireEvent.click(screen.getByRole("button", { name: "Animales" }));
    expect(radios().map((r) => r.value)).toContain("bruno");
    fireEvent.click(screen.getByRole("button", { name: "Todos" }));
    expect(radios()).toHaveLength(220);
    fireEvent.click(radios().find((r) => r.value === "luna")!);
    expect(picked).toEqual(["luna"]);
  });

  it("searches every category by name, accents ignored, with an empty state", () => {
    picker();
    const search = screen.getByRole("searchbox", { name: "Buscar compañero" });
    fireEvent.change(search, { target: { value: "bambu" } });
    expect(radios().map((r) => r.value)).toEqual(["bambu"]);
    expect(screen.getByRole("button", { name: "Todos" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByTestId("companion-empty").textContent).toBe("No encontramos a nadie con ese nombre.");
  });

  it("labels categories in English", () => {
    picker("bruno", undefined, "en");
    expect(screen.getByRole("button", { name: "Animals" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Vehicles & space" })).toBeTruthy();
  });
});

describe("phone verification", () => {
  const panel = (verifier: PhoneVerifier, onChange: (k: string, v: unknown) => void, values = DEFAULT_SETTINGS) =>
    renderUi(
      <SettingsPanel
        shell="web"
        values={values}
        onChange={onChange as never}
        providerLabel={(p) => p}
        hubPlansUrl="#"
        phoneVerifier={verifier}
      />,
    );

  it("no code is sent before 'Entiendo que pueden aplicar cargos'", () => {
    const v = mockVerifier();
    panel(v, () => undefined);
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "55 1234 5678" } });
    expect((screen.getByRole("button", { name: "Enviar código" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Primero confirma que entiendes que pueden aplicar cargos.").length).toBeGreaterThan(0);
  });

  it("any country code, by SMS or call; verified only after the right code", async () => {
    const v = mockVerifier();
    const changes: [string, unknown][] = [];
    panel(v, (k, val) => changes.push([k, val]), { ...DEFAULT_SETTINGS, chargesAck: true });
    fireEvent.change(screen.getByLabelText("País o región"), { target: { value: "JP" } });
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "090-1234-5678" } });
    fireEvent.click(screen.getByLabelText("Por llamada"));
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    expect(await screen.findByText("Te enviamos un código a +819012345678.")).toBeTruthy();
    expect(v.started).toEqual(["+819012345678:call"]);
    expect(changes).toEqual([]);
    fireEvent.change(screen.getByLabelText("Código"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    expect(await screen.findByText("Ese código no es correcto.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Código"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    expect(await screen.findByTestId("phone-verified")).toBeTruthy();
    expect(changes).toEqual([["phone", { e164: "+819012345678", verified: true }]]);
  });

  it("a number already on another account says so", async () => {
    const v: PhoneVerifier = {
      start: async () => ({ ok: true }),
      check: async () => ({ ok: false, reason: "in_use" }),
    };
    panel(v, () => undefined, { ...DEFAULT_SETTINGS, chargesAck: true });
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "55 1234 5678" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    fireEvent.change(await screen.findByLabelText("Código"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    expect(await screen.findByText("Ese número ya está en otra cuenta.")).toBeTruthy();
  });

  it("an invalid number never reaches the verifier", async () => {
    const v = mockVerifier();
    panel(v, () => undefined, { ...DEFAULT_SETTINGS, chargesAck: true });
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no parece válido");
    expect(v.started).toEqual([]);
  });
});
