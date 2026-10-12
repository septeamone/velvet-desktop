import channelsData from "./data/channels.json";
import { settings } from "./settings";
import { loadCustom } from "./custom";

export type Source = string | { rutube: string };
export type Channel = { id: string; name: string; logo: string; sources: Source[]; epg: string | null; tile?: "light"; adult?: boolean; custom?: boolean; hue?: number; res?: (number | null)[] };
export type Program = { s: number; e: number; t: string; a: string; d: string };

/* платные каналы лежат в отдельном локальном файле (его нет в публичном репозитории) */
const extra = import.meta.glob("./data/paid.json", { eager: true, import: "default" }) as Record<string, Channel[]>;
const baseChannels: Channel[] = [...(channelsData as Channel[]), ...Object.values(extra).flat()];

/* общий список: встроенные каналы + свои; взрослые видны только когда это включено в настройках */
export const channels: Channel[] = [];
export function rebuildChannels() {
  const mine: Channel[] = loadCustom()
    .filter((c) => !c.adult || settings.adult === "on")
    .map((c) => ({ id: c.id, name: c.name, logo: "", sources: [c.url], epg: null, custom: true, adult: c.adult, hue: [...c.name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7) }));
  channels.length = 0;
  channels.push(...baseChannels, ...mine);
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
