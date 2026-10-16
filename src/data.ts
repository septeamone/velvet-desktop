import channelsData from "./data/channels.json";
import { settings } from "./settings";
import { loadCustom } from "./custom";
import { tauri } from "./tauri";

export type Source = string | { rutube: string };
export type Channel = { id: string; name: string; logo: string; sources: Source[]; epg: string | null; tile?: "light"; adult?: boolean; custom?: boolean; hue?: number; res?: (number | null)[] };
export type Program = { s: number; e: number; t: string; a: string; d: string };

/* платные каналы лежат в отдельном локальном файле (его нет в публичном репозитории) */
const extra = import.meta.glob("./data/paid.json", { eager: true, import: "default" }) as Record<string, Channel[]>;
const baseChannels: Channel[] = [...(channelsData as Channel[]), ...Object.values(extra).flat()];

/* общий список: встроенные каналы + свои; взрослые видны только когда это включено в настройках */
const ORDER_KEY = "velvet.order.tv";
function loadOrder(): string[] {
  try { return JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as string[]; } catch { return []; }
}
export function saveOrder(ids: string[]) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch { /* не страшно */ }
}
export function resetOrder() {
  try { localStorage.removeItem(ORDER_KEY); localStorage.removeItem("velvet.rorder"); } catch { /* не страшно */ }
  window.dispatchEvent(new Event("velvet:order-reset"));
}

/* дополнительные каналы из локального файла extra-channels.json (см. extra_channels в Rust); проверяем форму, лишнее отбрасываем */
let localExtra: Channel[] = [];
const isSource = (s: unknown) => typeof s === "string" || (typeof s === "object" && s !== null && typeof (s as { rutube?: unknown }).rutube === "string");
export function parseExtra(text: string): Channel[] {
  try {
    const list = JSON.parse(text) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((c): c is Channel => !!c && typeof c.id === "string" && typeof c.name === "string" && Array.isArray(c.sources) && c.sources.length > 0 && c.sources.every(isSource))
      .map((c) => ({ id: c.id, name: c.name, logo: typeof c.logo === "string" ? c.logo : "", sources: c.sources, epg: typeof c.epg === "string" ? c.epg : null, ...(c.tile === "light" ? { tile: "light" as const } : {}) }));
  } catch { return []; }
}
export async function loadExtraChannels() {
  const text = await tauri()?.core.invoke<string | null>("extra_channels").catch(() => null);
  if (!text) return;
  localExtra = parseExtra(text);
  if (localExtra.length) rebuildChannels();
}

export const channels: Channel[] = [];
export function rebuildChannels() {
  const mine: Channel[] = loadCustom()
    .filter((c) => !c.adult || settings.adult === "on")
    .map((c) => ({ id: c.id, name: c.name, logo: "", sources: [c.url], epg: null, custom: true, adult: c.adult, hue: [...c.name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7) }));
  const have = new Set(baseChannels.map((c) => c.id));
  const all = [...baseChannels, ...localExtra.filter((c) => !have.has(c.id)), ...mine]; // у сборок с вшитыми каналами те же каналы уже есть — дублей не делаем
  const saved = loadOrder();
  const rank = new Map(saved.map((id, i) => [id, i]));
  const base = new Map(all.map((c, i) => [c.id, i]));
  all.sort((a, b) => (rank.get(a.id) ?? 10000 + base.get(a.id)!) - (rank.get(b.id) ?? 10000 + base.get(b.id)!)); // свой порядок, новые каналы в конце
  channels.length = 0;
  channels.push(...all);
  window.dispatchEvent(new Event("velvet:channels"));
}
rebuildChannels();

let epg: Record<string, Program[]> = {};
export const setEpg = (next: Record<string, Program[]>) => { epg = next; };
let hosted: Record<string, Program[]> = {};
export const setHosted = (next: Record<string, Program[]>) => { hosted = next; };

/* сначала расписание Rutube (оно живое), потом наш компактный файл с GitHub */
export const programsOf = (c: Channel): Program[] => (c.epg && epg[c.epg]?.length ? epg[c.epg] : hosted[c.id] ?? []);

export function nowOf(c: Channel, t = Date.now()) {
  const list = programsOf(c);
  return { cur: list.find((x) => x.s <= t && t < x.e), next: list.find((x) => x.s >= t) };
}

export const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: settings.tz === "msk" ? "Europe/Moscow" : undefined });

export const minutes = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, "0")} мин` : `${m} мин`;
};
