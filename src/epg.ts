/* Программа передач: берём у Rutube (там же, где и на их сайте), обновляем в фоне и помним последнюю копию. */
import { setEpg, setHosted, type Program } from "./data";
import { viaProxy } from "./net";

const KEY = "velvet.epg";
const KEY_HOSTED = "velvet.epgh";
const HOSTED = [
  "https://raw.githubusercontent.com/septeamone/velvet-desktop/main/data/epg.json",
  "https://cdn.jsdelivr.net/gh/septeamone/velvet-desktop@main/data/epg.json",
];
const ENDPOINT =
  "https://rutube.ru/api/v2/video/stream/tvbroadcastinfo/?client=wdp&category=1&tvprogramm=true&video_id=c58f502c7bb34a8fcdd976b221fca292&programmDate=";

type Raw = {
  results?: { author?: { name?: string }; schedule?: { start: string; stop: string; title: string; description?: string; ageRating?: string }[] }[];
};

const mskDay = (offset: number) => new Date(Date.now() + 3 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10).replace(/-/g, "");

async function loadDay(offset: number): Promise<Raw> {
  const r = await fetch(viaProxy(ENDPOINT + mskDay(offset)));
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as Raw;
}

function announce() {
  window.dispatchEvent(new Event("velvet:epg"));
}

type Hosted = { generated: number; channels: Record<string, [number, number, string, string, string][]> };

function useHosted(h: Hosted) {
  const out: Record<string, Program[]> = {};
  for (const [id, list] of Object.entries(h.channels)) out[id] = list.map(([s, e, t, a, d]) => ({ s: s * 1000, e: e * 1000, t, a, d }));
  setHosted(out);
}

export function restoreEpg() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, Program[]> | null;
    if (saved) setEpg(saved);
  } catch { /* кеша нет */ }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY_HOSTED) ?? "null") as Hosted | null;
    if (saved) useHosted(saved);
  } catch { /* кеша нет */ }
}

/* наш файл с GitHub: программа для каналов, которых нет у Rutube */
export async function refreshHosted(): Promise<boolean> {
  for (const url of HOSTED) {
    try {
      const r = await fetch(viaProxy(url), { cache: "no-store" });
      if (!r.ok) continue;
      const h = (await r.json()) as Hosted;
      if (!h.channels) continue;
      useHosted(h);
      try { localStorage.setItem(KEY_HOSTED, JSON.stringify(h)); } catch { /* не страшно */ }
      announce();
      return true;
    } catch { /* пробуем следующий адрес */ }
  }
  return false;
}

export async function refreshEpg(): Promise<boolean> {
  const merged: Record<string, Map<number, Program>> = {};
  let got = false;
  const days = await Promise.allSettled([-1, 0, 1].map(loadDay));
  for (const res of days) {
    if (res.status !== "fulfilled") continue; // этот день не загрузился — берём остальные
    for (const ch of res.value.results ?? []) {
      const name = ch.author?.name;
      if (!name || !ch.schedule?.length) continue;
      const map = (merged[name] ??= new Map());
      for (const p of ch.schedule) {
        const s = Date.parse(p.start);
        map.set(s, { s, e: Date.parse(p.stop), t: p.title, a: p.ageRating ?? "", d: (p.description ?? "").slice(0, 240) });
      }
      got = true;
    }
  }
  if (!got) return false;
  const out: Record<string, Program[]> = {};
  for (const [name, map] of Object.entries(merged)) out[name] = [...map.values()].sort((a, b) => a.s - b.s);
  setEpg(out);
  try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* не страшно */ }
  announce();
  return true;
}

export function startEpg() {
  restoreEpg();
  announce();
  const all = () => { void refreshEpg(); void refreshHosted(); };
  all();
  setInterval(all, 20 * 60 * 1000);
  // после сна компьютера данные могли устареть
  document.addEventListener("visibilitychange", () => { if (!document.hidden) all(); });
}
