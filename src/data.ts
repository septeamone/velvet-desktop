import channelsData from "./data/channels.json";
import { settings } from "./settings";

export type Source = string | { rutube: string };
export type Channel = { id: string; name: string; logo: string; sources: Source[]; epg: string | null; tile?: "light" };
export type Program = { s: number; e: number; t: string; a: string; d: string };

export const channels = channelsData as Channel[];

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
