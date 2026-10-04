import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import es from "../messages/es.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
import {
  DEFAULT_SETTINGS,
  SETTINGS,
  SHELLS,
  SettingsPanel,
  type SettingKey,
  type SettingsValues,
} from "../src/index.js";
import { renderUi } from "./helpers.js";

afterEach(cleanup);

/** Every setting the brief lists (M5 "settings parity"). */
const REQUIRED: SettingKey[] = [
  "phone",
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

  it("es and en catalogs have the same keys", () => {
    const keys = (o: unknown, p = ""): string[] =>
      typeof o === "object" && o ? Object.entries(o).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k)) : [p];
    expect(keys(en).sort()).toEqual(keys(es).sort());
  });
});

describe("charges notice", () => {
  it("shows 'Pueden aplicar cargos' / 'Charges may apply' only when WhatsApp or calls are on", () => {
    const withPhone = { ...DEFAULT_SETTINGS, phone: "+525512345678" };
    renderUi(<Panel shell="web" values={withPhone} />);
    expect(screen.queryByTestId("charges-notice")).toBeNull();
    cleanup();
    renderUi(<Panel shell="web" values={{ ...withPhone, whatsapp: true }} />);
    expect(screen.getByTestId("charges-notice").textContent).toBe("Pueden aplicar cargos.");
    cleanup();
    renderUi(<Panel shell="desktop" values={{ ...withPhone, calls: true }} />, "en");
    expect(screen.getByTestId("charges-notice").textContent).toBe("Charges may apply.");
  });

  it("WhatsApp and calls stay off until there is a phone", () => {
    renderUi(<Panel shell="web" />);
    for (const s of screen.getAllByRole("switch").slice(0, 2)) expect((s as HTMLInputElement).disabled).toBe(true);
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

describe("phone", () => {
  it("accepts any country code and stores E.164 only when valid", () => {
    let phone: string | null = "unset";
    renderUi(
      <SettingsPanel
        shell="web"
        values={DEFAULT_SETTINGS}
        onChange={(k, v) => {
          if (k === "phone") phone = v as string | null;
        }}
        providerLabel={(p) => p}
        hubPlansUrl="#"
      />,
    );
    fireEvent.change(screen.getByLabelText("País o región"), { target: { value: "JP" } });
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "090-1234-5678" } });
    expect(phone).toBe("+819012345678");
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "12" } });
    expect(phone).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
