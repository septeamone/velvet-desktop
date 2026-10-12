import Hls from "hls.js";
import radioData from "./data/radio.json";
import { fetchTrack } from "./nowplaying";
import { viaProxy } from "./net";
import { settings } from "./settings";

type RQ = { k: number; u: string[]; h?: 1; hls?: 1; n?: string };
type Station = { id: string; name: string; alt?: string; cc: string; g: string; gn: string; mark: string; hue: number; logo?: 1; q: RQ[] };
type Country = { cc: string; aliases?: string[] };

const stations = (radioData as { stations: Station[] }).stations;
const countries = (radioData as { countries: Country[] }).countries;
const regionNames = new Intl.DisplayNames(["ru"], { type: "region" });
const countryName = (cc: string) => { try { return regionNames.of(cc) ?? cc; } catch { return cc; } };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const shell = $("shell");
const audio = new Audio();
audio.preload = "none";

type Status = "idle" | "connecting" | "playing" | "error";
let current: Station | null = null;
let status: Status = "idle";
let kbps = 0;
let track = "";
let gen = 0;
let hlsA: Hls | null = null;
let lastT = -1;
let stuckAt = 0;
let trackTimer = 0;

let fav = new Set<string>();
try { fav = new Set(JSON.parse(localStorage.getItem("velvet.fav") ?? "[]") as string[]); } catch { /* пусто */ }
const saveFav = () => { try { localStorage.setItem("velvet.fav", JSON.stringify([...fav])); } catch { /* не страшно */ } };

let wantedK = 0; // выбранное человеком качество (0 — по настройкам)
try { wantedK = Number(localStorage.getItem("velvet.rq") ?? 0) || 0; } catch { /* пусто */ }

/* ---------------- движок ---------------- */

const shown = (s: Station) => { const v = s.q.filter((x) => !x.h); return v.length ? v : s.q.slice(-1); };

function pickQuality(s: Station): RQ {
  const vis = shown(s);
  if (wantedK && vis.some((x) => x.k === wantedK)) return vis.find((x) => x.k === wantedK)!;
  return settings.quality === "low" ? vis[0] : vis[vis.length - 1];
}

function cleanup() {
  hlsA?.destroy();
  hlsA = null;
  audio.removeAttribute("src");
  audio.load();
}

function attempt(url: string, isHls: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    cleanup();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.removeEventListener("playing", onPlay);
      audio.removeEventListener("error", onErr);
      resolve(ok);
    };
    const onPlay = () => finish(true);
    const onErr = () => finish(false);
    const timer = window.setTimeout(() => finish(false), 9000);
    audio.addEventListener("playing", onPlay);
    audio.addEventListener("error", onErr);
    if (isHls) {
      const h = new Hls({ lowLatencyMode: false, maxBufferLength: 20 });
      hlsA = h;
      h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) finish(false); });
      h.loadSource(viaProxy(url));
      h.attachMedia(audio);
    } else {
      audio.src = viaProxy(url);
    }
    audio.play().catch(() => undefined);
  });
}

/* выбранное качество → все адреса (два круга) → качества ниже → ошибка */
async function connect(s: Station) {
  const mine = ++gen;
  set("connecting");
  const first = pickQuality(s);
  const chain = [first, ...s.q.filter((x) => x.k < first.k).sort((a, b) => b.k - a.k)];
  for (let qi = 0; qi < chain.length; qi++) {
    const rounds = qi === 0 ? 2 : 1;
    for (let r = 0; r < rounds; r++) {
      for (const url of chain[qi].u) {
        if (mine !== gen) return;
        if (await attempt(url, !!chain[qi].hls)) {
          if (mine !== gen) return;
          kbps = chain[qi].k;
          lastT = -1;
          stuckAt = performance.now();
          set("playing");
          return;
        }
      }
    }
  }
  if (mine === gen) { cleanup(); set("error"); }
}

export function playStation(s: Station) {
  pauseVideoHook();
  if (current?.id === s.id && status === "playing") { audio.paused ? void audio.play() : audio.pause(); render(); return; }
  current = s;
  track = "";
  kbps = 0;
  fetchNow();
  void connect(s);
  render();
}

function togglePlay() {
  if (!current) return;
  if (status === "error" || status === "idle") return void connect(current);
  if (audio.paused) { pauseVideoHook(); void audio.play(); } else audio.pause();
  render();
}

function step(dir: number) {
  const list = visible();
  const base = list.length ? list : stations;
  const i = base.findIndex((x) => x.id === current?.id);
  playStation(base[(i + dir + base.length) % base.length]);
}

export function pauseRadio() {
  if (!audio.paused) audio.pause();
  render();
}
let pauseVideoHook = () => undefined as void;
export function onRadioStart(f: () => void) { pauseVideoHook = f; }

audio.addEventListener("pause", render);
audio.addEventListener("play", render);
audio.addEventListener("error", () => { if (status === "playing" && current) { void connect(current); } });

/* сторож: если звук завис на 9 секунд — переподключаемся */
setInterval(() => {
  if (status !== "playing" || audio.paused || !current) { stuckAt = performance.now(); return; }
  if (audio.currentTime !== lastT) { lastT = audio.currentTime; stuckAt = performance.now(); return; }
  if (performance.now() - stuckAt > 9000) void connect(current);
}, 1000);

function set(s: Status) {
  status = s;
  render();
}

/* название песни */
function fetchNow() {
  clearInterval(trackTimer);
  const s = current;
  if (!s) return;
  const load = async () => {
    try {
      const t = await fetchTrack(s.id);
      if (t && current?.id === s.id) { track = t; render(); }
    } catch { /* оставляем прошлое */ }
  };
  void load();
  trackTimer = window.setInterval(() => { if (!audio.paused) void load(); }, 20000);
}

/* ---------------- интерфейс ---------------- */

let query = "";
let ccFilter: string = fav.size ? "FAV" : "RU";
let genreFilter = "";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function logoOf(s: Station, cls: string) {
  const box = el("span", cls);
  if (s.logo) {
    const img = el("img");
    img.src = `/radio/${s.id}.png`;
    img.alt = "";
    img.draggable = false;
    box.append(img);
  } else {
    box.textContent = s.mark;
    box.style.background = `hsl(${s.hue} 45% 30%)`;
    box.style.color = "#fff";
    box.classList.add("mark");
  }
  return box;
}

const norm = (x: string) => x.toLowerCase().replaceAll("ё", "е");

function visible(): Station[] {
  const q = norm(query.trim());
  return stations.filter((s) => {
    if (ccFilter === "FAV" ? !fav.has(s.id) : ccFilter !== "ALL" && s.cc !== ccFilter) return false;
    if (genreFilter && s.g !== genreFilter) return false;
    if (!q) return true;
    const c = countries.find((x) => x.cc === s.cc);
    return norm(`${s.name} ${s.alt ?? ""} ${s.gn} ${countryName(s.cc)} ${(c?.aliases ?? []).join(" ")}`).includes(q);
  });
}

function chip(label: string, active: boolean, onClick: () => void, flag?: string) {
  const b = el("button", "chip-f");
  b.type = "button";
  b.setAttribute("aria-pressed", String(active));
  if (flag) {
    const f = el("img", "flag");
    f.src = `/flags/${flag.toLowerCase()}.svg`;
    f.alt = "";
    b.append(f);
  }
  b.append(label);
  b.onclick = onClick;
  return b;
}

function drawFilters() {
  const cc = $("rCountries");
  cc.replaceChildren(
    chip(`Избранное${fav.size ? ` · ${fav.size}` : ""}`, ccFilter === "FAV", () => { ccFilter = "FAV"; genreFilter = ""; drawAll(); }),
    chip("Все страны", ccFilter === "ALL", () => { ccFilter = "ALL"; genreFilter = ""; drawAll(); }),
    ...countries.map((c) => chip(countryName(c.cc), ccFilter === c.cc, () => { ccFilter = c.cc; genreFilter = ""; drawAll(); }, c.cc)),
  );
  const pool = stations.filter((s) => (ccFilter === "FAV" ? fav.has(s.id) : ccFilter === "ALL" || s.cc === ccFilter));
  const seen = new Map<string, string>();
  for (const s of pool) seen.set(s.g, s.gn);
  const gr = $("rGenres");
  gr.replaceChildren(
    ...(seen.size > 1 ? [chip("Все жанры", !genreFilter, () => { genreFilter = ""; drawAll(); })] : []),
    ...(seen.size > 1 ? [...seen].sort((a, b) => a[1].localeCompare(b[1], "ru")).map(([k, n]) => chip(n, genreFilter === k, () => { genreFilter = genreFilter === k ? "" : k; drawAll(); })) : []),
  );
}

function stationCard(s: Station) {
  const card = el("div", "scard");
  const play = el("button", "s-main");
  play.type = "button";
  const maxK = shown(s).at(-1)!.k;
  const info = el("span", "info");
  info.append(el("span", "c-title", s.name), el("span", "c-name", `${s.gn} · до ${maxK} kbps`));
  play.append(logoOf(s, "logo"), info);
  const isNow = current?.id === s.id;
  if (isNow) {
    card.classList.add("now");
    const eq = el("span", `eq${status === "playing" && !audio.paused ? " on" : ""}`);
    eq.append(el("i"), el("i"), el("i"));
    play.append(eq);
  }
  play.setAttribute("aria-label", `${s.name}, ${s.gn}`);
  play.onclick = () => playStation(s);
  const heart = el("button", "heart");
  heart.type = "button";
  heart.setAttribute("aria-label", fav.has(s.id) ? "Убрать из избранного" : "В избранное");
  heart.setAttribute("aria-pressed", String(fav.has(s.id)));
  heart.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.4 5 6.6 5c2 0 3.5 1.1 4.4 2.6h2C13.9 6.1 15.4 5 17.4 5c3.2 0 5.1 3 3.9 6.3-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>';
  heart.onclick = (e) => {
    e.stopPropagation();
    if (!fav.delete(s.id)) fav.add(s.id);
    saveFav();
    drawAll();
  };
  card.append(play, heart);
  return card;
}

function drawGrid() {
  const list = visible();
  const grid = $("rGrid");
  grid.replaceChildren();
  if (!list.length) {
    grid.append(el("p", "r-empty", ccFilter === "FAV" && !query ? "Здесь будут станции, которые вы отметили сердечком." : "Ничего не найдено."));
    return;
  }
  grid.append(...list.map(stationCard));
}

function drawAll() {
  drawFilters();
  drawGrid();
}

/* мини-плеер */
const mini = $("mini"), mPlay = $("mPlay"), mName = $("mName"), mTrack = $("mTrack"), mQ = $("mQ"), mQMenu = $("mQMenu"), mLogo = $("mLogo");
const mVol = $<HTMLInputElement>("mVol");

const ICON_PLAY = '<path d="M8 5.5v13l11-6.5z"/>';
const ICON_PAUSE = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>';

function render() {
  const has = !!current;
  mini.classList.toggle("open", has);
  shell.classList.toggle("has-mini", has);
  if (!current) return;
  const playing = status === "playing" && !audio.paused;
  mName.textContent = current.name;
  mTrack.textContent =
    status === "connecting" ? "Подключаюсь…" :
    status === "error" ? "Станция сейчас недоступна" :
    track || current.gn;
  mTrack.classList.toggle("err", status === "error");
  $("mPlayIcon").innerHTML = playing || status === "connecting" ? ICON_PAUSE : ICON_PLAY;
  mPlay.setAttribute("aria-label", playing ? "Пауза" : "Играть");
  mLogo.replaceChildren(...logoOf(current, "logo sm").childNodes);
  mLogo.className = `logo sm${current.logo ? "" : " mark"}`;
  mLogo.style.background = current.logo ? "" : `hsl(${current.hue} 45% 30%)`;
  mQ.hidden = shown(current).length < 2;
  mQ.textContent = kbps ? `${kbps} kbps` : "Качество";
  mQMenu.replaceChildren(...shown(current).map((q) => {
    const b = el("button");
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", String(q.k === kbps));
    b.append(el("span", undefined, `${q.k} kbps`));
    if (q.n) b.title = q.n;
    b.onclick = () => {
      wantedK = q.k;
      try { localStorage.setItem("velvet.rq", String(q.k)); } catch { /* не страшно */ }
      mQMenu.classList.remove("open");
      if (current) void connect(current);
    };
    return b;
  }));
  // карточки подсвечиваем без полной перерисовки
  if (shell.dataset.view === "radio") drawGrid();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track || current.name, artist: current.name,
      artwork: current.logo ? [{ src: `/radio/${current.id}.png`, sizes: "128x128", type: "image/png" }] : [],
    });
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }
}

export function initRadio() {
  drawAll();
  $<HTMLInputElement>("rSearch").addEventListener("input", (e) => { query = (e.target as HTMLInputElement).value; drawGrid(); });
  mPlay.onclick = togglePlay;
  $("mPrev").onclick = () => step(-1);
  $("mNext").onclick = () => step(1);
  mQ.onclick = (e) => { e.stopPropagation(); mQMenu.classList.toggle("open"); };
  document.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest(".mqwrap")) mQMenu.classList.remove("open"); });

  let v = 0.8;
  try { v = Number(localStorage.getItem("velvet.rvol") ?? 0.8); } catch { /* пусто */ }
  audio.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
  mVol.value = String(audio.volume);
  const paintVol = () => mVol.style.setProperty("--p", `${audio.volume * 100}%`);
  paintVol();
  mVol.addEventListener("input", () => {
    audio.volume = Number(mVol.value);
    paintVol();
    try { localStorage.setItem("velvet.rvol", String(audio.volume)); } catch { /* не страшно */ }
  });

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => togglePlay());
    navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
  }
}

export const redrawRadio = drawAll;
