/* Движок радио: плавный переход между станциями, выбор качества, запасные потоки, сторож зависаний, названия песен. */
import type HlsType from "hls.js";
import radioData from "./data/radio.json";
import { fetchTrack } from "./nowplaying";
import { viaProxy } from "./net";
import { settings } from "./settings";

export type RQ = { k: number; u: string[]; h?: 1; hls?: 1; n?: string };
export type Station = { id: string; name: string; alt?: string; cc: string; g: string; gn: string; mark: string; hue: number; logo?: 1; q: RQ[] };
export type Country = { cc: string; aliases?: string[] };
export type Status = "idle" | "connecting" | "playing" | "error";

export const stations = (radioData as { stations: Station[] }).stations;
export const countries = (radioData as { countries: Country[] }).countries;

/* качества, которые показываем кнопками (скрытые нужны только как запас) */
export const shown = (s: Station) => {
  const v = s.q.filter((x) => !x.h);
  return v.length ? v : s.q.slice(-1);
};

export const state = {
  station: null as Station | null,
  status: "idle" as Status,
  kbps: 0,
  track: "",
  paused: false,
  volume: 0.8,
};

const listeners = new Set<() => void>();
export const onRadio = (f: () => void) => { listeners.add(f); };
const emit = () => listeners.forEach((f) => f());

/* ---------- звук: два «слота», чтобы старая станция играла, пока новая подключается ---------- */

type Slot = { el: HTMLAudioElement; gain: GainNode | null; hls: HlsType | null };
const makeSlot = (): Slot => {
  const el = new Audio();
  el.crossOrigin = "anonymous"; // наш прокси разрешает чтение, поэтому визуализатор работает у всех станций
  el.preload = "none";
  return { el, gain: null, hls: null };
};
const slots: [Slot, Slot] = [makeSlot(), makeSlot()];
let active = 0;
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let HlsCls: typeof HlsType | null = null;

try { state.volume = Number(localStorage.getItem("velvet.rvol") ?? 0.8); } catch { /* пока по умолчанию */ }
if (!Number.isFinite(state.volume)) state.volume = 0.8;

function ensureGraph() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: "playback" });
  master = ctx.createGain();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 512; // как в расширении
  analyser.smoothingTimeConstant = 0.6;
  master.connect(analyser);
  analyser.connect(ctx.destination);
  for (const s of slots) {
    const src = ctx.createMediaElementSource(s.el);
    s.gain = ctx.createGain();
    s.gain.gain.value = 0;
    src.connect(s.gain);
    s.gain.connect(master);
  }
  applyVolume();
}

/* громкость по закону слуха: у середины ползунка звук заметно тише, а не «почти полный» */
function applyVolume() {
  if (master && ctx) master.gain.setTargetAtTime(state.volume * state.volume, ctx.currentTime, 0.02);
}

let beforeMute = 0.6;
export function toggleMute() {
  if (state.volume > 0) { beforeMute = state.volume; setVolume(0); }
  else setVolume(beforeMute || 0.6);
}

export function setVolume(v: number) {
  state.volume = Math.min(1, Math.max(0, v));
  try { localStorage.setItem("velvet.rvol", String(state.volume)); } catch { /* не страшно */ }
  applyVolume();
  emit();
}

/* уровни полос для визуализатора (как в расширении: логарифмические полосы, выше ~10 кГц почти тишина); false, если сейчас нечего показывать */
let freqBuf = new Uint8Array(256);
export function levels(out: Float32Array): boolean {
  if (!analyser || state.status !== "playing" || state.paused) return false;
  if (freqBuf.length !== analyser.frequencyBinCount) freqBuf = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freqBuf);
  const bands = out.length;
  const top = Math.floor(freqBuf.length * 0.4);
  for (let i = 0; i < bands; i++) {
    const a = Math.floor(Math.pow(i / bands, 1.7) * top);
    const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / bands, 1.7) * top));
    let sum = 0;
    for (let k = a; k < b; k++) sum += freqBuf[k];
    out[i] = sum / (b - a) / 255;
  }
  return true;
}

function wipe(s: Slot) {
  s.hls?.destroy();
  s.hls = null;
  s.el.pause();
  s.el.removeAttribute("src");
  s.el.load();
  if (s.gain && ctx) s.gain.gain.cancelScheduledValues(ctx.currentTime);
  if (s.gain) s.gain.gain.value = 0;
}

/* пробуем один адрес: звук не слышен, пока не наберётся запас — так меньше заиканий */
function attempt(s: Slot, url: string, isHls: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    wipe(s);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      s.el.removeEventListener("error", onErr);
      resolve(ok);
    };
    const onErr = () => finish(false);
    const timer = window.setTimeout(() => finish(false), 14000);
    const t0 = performance.now();
    const poll = window.setInterval(() => {
      const el = s.el;
      if (el.readyState < 3 || el.currentTime <= 0) return;
      const ahead = el.buffered.length ? el.buffered.end(el.buffered.length - 1) - el.currentTime : 0;
      if (ahead >= 3 || performance.now() - t0 > 9000) finish(true);
    }, 250);
    s.el.addEventListener("error", onErr);
    void (async () => {
      try {
        if (isHls) {
          HlsCls ??= (await import("hls.js")).default;
          const h = new HlsCls({ lowLatencyMode: false, maxBufferLength: 20 });
          s.hls = h;
          h.on(HlsCls.Events.ERROR, (_e, d) => { if (d.fatal) finish(false); });
          h.loadSource(viaProxy(url));
          h.attachMedia(s.el);
        } else {
          s.el.src = viaProxy(url);
        }
        await s.el.play();
      } catch {
        finish(false);
      }
    })();
  });
}

function fade(s: Slot, to: number, seconds: number) {
  if (!s.gain || !ctx) return;
  const g = s.gain.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setValueAtTime(g.value, ctx.currentTime);
  g.linearRampToValueAtTime(to, ctx.currentTime + seconds);
}

let gen = 0;
let wanted = 0; // выбранное человеком качество (kbps); 0 — по умолчанию
try { wanted = Number(localStorage.getItem("velvet.rq") ?? 0) || 0; } catch { /* пусто */ }

function pickQuality(s: Station): RQ {
  const vis = shown(s);
  const exact = wanted ? vis.find((x) => x.k === wanted) : undefined;
  if (exact) return exact;
  return settings.quality === "low" ? vis[0] : vis[vis.length - 1];
}

/* выбранное качество → все его адреса (два круга) → качества ниже → ошибка */
async function connect(s: Station, quiet = false) {
  const mine = ++gen;
  ensureGraph();
  void ctx?.resume();
  const previous = state.station;
  const wasPlaying = state.status === "playing" && !state.paused;
  state.station = s;
  state.paused = false;
  if (!quiet || !wasPlaying) state.status = "connecting";
  emit();
  const target = 1 - active;
  const first = pickQuality(s);
  const chain = [first, ...s.q.filter((x) => x.k < first.k).sort((a, b) => b.k - a.k)];
  for (let qi = 0; qi < chain.length; qi++) {
    for (let round = 0; round < (qi === 0 ? 2 : 1); round++) {
      for (const url of chain[qi].u) {
        if (mine !== gen) return;
        if (await attempt(slots[target], url, !!chain[qi].hls)) {
          if (mine !== gen) { wipe(slots[target]); return; }
          const old = slots[active];
          active = target;
          fade(slots[target], 1, wasPlaying ? 0.9 : 0.35);
          if (wasPlaying) {
            fade(old, 0, 0.9);
            window.setTimeout(() => { if (slots[active] !== old) wipe(old); }, 1100);
          } else wipe(old);
          state.kbps = chain[qi].k;
          state.status = "playing";
          stuckAt = performance.now();
          lastTime = -1;
          emit();
          return;
        }
      }
    }
  }
  if (mine !== gen) return;
  wipe(slots[target]);
  if (wasPlaying && previous) { // новая станция недоступна, а прежняя продолжает играть
    state.station = previous;
    state.status = "playing";
    notice("Станция сейчас недоступна");
  } else {
    state.status = "error";
  }
  emit();
}

/* сообщения вроде «Станция недоступна» (показывает интерфейс) */
let noticeText = "";
export const lastNotice = () => noticeText;
function notice(text: string) {
  noticeText = text;
  window.dispatchEvent(new CustomEvent("velvet:rnotice", { detail: text }));
}

export function play(s: Station) {
  window.dispatchEvent(new Event("velvet:radio-start")); // телевидение остановится
  if (state.station?.id === s.id && state.status === "playing") {
    toggle();
    return;
  }
  state.track = "";
  fetchNow(s);
  void connect(s);
  installMedia();
}

export function toggle() {
  const s = state.station;
  if (!s) return;
  if (state.status === "error" || state.status === "idle") { play(s); return; }
  const el = slots[active].el;
  if (state.paused) {
    window.dispatchEvent(new Event("velvet:radio-start"));
    void ctx?.resume();
    void el.play();
    state.paused = false;
  } else {
    el.pause();
    state.paused = true;
  }
  emit();
  syncMedia();
}

export function stop() {
  gen++;
  for (const s of slots) wipe(s);
  state.status = "idle";
  state.paused = false;
  emit();
}

/* телевидение запустили — радио уступает */
window.addEventListener("velvet:tv-start", () => {
  if (state.station && state.status !== "idle" && !state.paused) {
    slots[active].el.pause();
    state.paused = true;
    emit();
  }
});

export function setQuality(k: number) {
  wanted = k;
  try { localStorage.setItem("velvet.rq", String(k)); } catch { /* не страшно */ }
  if (state.station) void connect(state.station, true);
}

/* ---------- сторож: если звук завис на 9 секунд, переподключаемся ---------- */
let lastTime = -1;
let stuckAt = 0;
setInterval(() => {
  const s = state.station;
  if (!s || state.status !== "playing" || state.paused) { stuckAt = performance.now(); return; }
  const t = slots[active].el.currentTime;
  if (t !== lastTime) { lastTime = t; stuckAt = performance.now(); return; }
  if (performance.now() - stuckAt > 9000) { stuckAt = performance.now(); void connect(s, true); }
}, 1000);
for (const slot of slots) {
  slot.el.addEventListener("error", () => {
    if (slot === slots[active] && state.status === "playing" && state.station) void connect(state.station, true);
  });
}

/* ---------- что играет сейчас ---------- */
let trackTimer = 0;
function fetchNow(s: Station) {
  clearInterval(trackTimer);
  const load = async () => {
    try {
      const t = await fetchTrack(s.id);
      if (t && state.station?.id === s.id) { state.track = t; emit(); syncMedia(); }
    } catch { /* оставляем прошлое */ }
  };
  void load();
  trackTimer = window.setInterval(() => { if (!state.paused) void load(); }, 20000);
}

/* ---------- медиаклавиши Windows ---------- */
let stepper: (dir: number) => void = () => undefined;
export function setStepper(f: (dir: number) => void) { stepper = f; }

function syncMedia() {
  const s = state.station;
  if (!s || !("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.track || s.name,
    artist: s.name,
    album: "Velvet TV · Радио",
    artwork: s.logo ? [{ src: new URL(`/radio/${s.id}.webp`, location.href).href, sizes: "128x128", type: "image/webp" }] : [],
  });
  navigator.mediaSession.playbackState = state.paused ? "paused" : "playing";
}

function installMedia() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const on = (a: MediaSessionAction, f: () => void) => { try { ms.setActionHandler(a, f); } catch { /* не поддерживается */ } };
  on("play", () => { if (state.paused) toggle(); });
  on("pause", () => { if (!state.paused) toggle(); });
  on("previoustrack", () => stepper(-1));
  on("nexttrack", () => stepper(1));
  syncMedia();
}

/* ---------- названия песен для списка (только лёгкие источники) ---------- */
export { LIVE } from "./nowplaying";
