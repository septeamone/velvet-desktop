import { tauri } from "./tauri";

export type Settings = {
  theme: "system" | "dark" | "light";
  quality: "auto" | "high" | "low";
  tz: "local" | "msk";
  start: "home" | "last";
  adult: "off" | "on";
};

export const settings: Settings = { theme: "dark", quality: "auto", tz: "local", start: "home", adult: "off" };

const KEY = "velvet.settings";
const listeners: Array<(k: keyof Settings) => void> = [];
const dark = matchMedia("(prefers-color-scheme: dark)");

export const onSetting = (f: (k: keyof Settings) => void) => listeners.push(f);

export function applyTheme() {
  const isDark = settings.theme === "dark" || (settings.theme === "system" && dark.matches);
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  // рамка окна Windows подстраивается под тему
  tauri()?.window.getCurrentWindow().setTheme(settings.theme === "system" ? null : settings.theme).catch(() => undefined);
}

export function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch { /* первый запуск */ }
  applyTheme();
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* не страшно */ }
  if (key === "theme") applyTheme();
  listeners.forEach((f) => f(key));
}

dark.addEventListener("change", () => { if (settings.theme === "system") applyTheme(); });
