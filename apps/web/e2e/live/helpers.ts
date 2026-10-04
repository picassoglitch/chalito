import { expect, type Page } from "@playwright/test";

type Row = Record<string, unknown>;
export interface Dev {
  me: string;
  agent: string;
  other: string;
  sid: string;
}

/** Waits for the in-browser mock backend (DEV/TEST ONLY) and the first live sync. */
export const ready = async (page: Page, path = "/bandeja") => {
  await page.goto(path);
  await expect(page.getByTestId("test-mode")).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __chalitoDev?: unknown }).__chalitoDev);
};

export const dev = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([f, a]) => {
      const d = (window as unknown as { __chalitoDev: Record<string, unknown> }).__chalitoDev;
      const v = d[f as string];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown)(...(a as unknown[])) : v;
    },
    [fn, args] as const,
  ) as Promise<T>;

export const rows = (page: Page, table: string) => dev<Row[]>(page, "rows", table);
export const clientWrites = (page: Page) => dev<{ table: string; op: string; row: Row }[]>(page, "clientWrites");
export const ids = async (page: Page): Promise<Dev> => ({
  me: await dev<string>(page, "me"),
  agent: await dev<string>(page, "agent"),
  other: await dev<string>(page, "other"),
  sid: await dev<string>(page, "sid"),
});
