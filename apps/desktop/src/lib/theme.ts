/** Light, dark, or follow the system: kept on this device only. */
export type Theme = "auto" | "light" | "dark";
export const THEMES: readonly Theme[] = ["auto", "light", "dark"];
const KEY = "chalito-desktop-theme";

export const loadTheme = (): Theme => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
};

/** Sets data-theme on <html> (styles.css reads it) and remembers the choice. */
export const applyTheme = (theme: Theme): void => {
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not persisted; still applies for this run.
  }
};
