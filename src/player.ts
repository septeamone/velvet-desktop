import type HlsType from "hls.js";
import { channels, programsOf, hhmm, minutes, type Source } from "./data";
import { settings } from "./settings";
import { viaProxy } from "./net";
import { isFav, toggleFav } from "./favs";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const shell = $("shell"), app = $("player"), v = $<HTMLVideoElement>("v"), rail = $("rail"), toast = $("toast"), mark = $("pauseMark");
const elTitle = $("title"), elTime = $("time"), elAge = $("age"), elBar = $("bar"), elProgress = $("progress");
const elElapsed = $("elapsed"), elNext = $("next"), elName = $("chName");
const btnVol = $("btnVol"), vol = $<HTMLInputElement>("vol"), volIcon = document.getElementById("volIcon") as unknown as SVGElement;
const btnFav = $("btnFav"), btnPip = $("btnPip");
const btnQ = $("btnQ"), qMenu = $("qMenu"), qLabel = $("qLabel"), guide = $("guide"), gList = $("gList"), gName = $("gName");

export const hooks = { back: () => undefined as void, restore: () => undefined as void };

let cur = 0;
let hls: HlsType | null = null;
let HlsCls: typeof HlsType | null = null;
let srcIdx = 0;
let level = -1; // -1 = авто
let srcPref = 0; // выбранное качество у каналов без своих уровней: 0 = авто, иначе высота картинки
let sourceMode = false;
let hideTimer = 0;
let toastTimer = 0;
let lastProgress = 0;
let lastTime = -1;
let stuckSince = 0;
let attempt = 0;

const active = () => shell.dataset.view === "player";
export const inPip = () => document.pictureInPictureElement === v;

function say(text: string, ms = 2400) {
  toast.textContent = text;
  toast.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("on"), ms);
}

/* ---------------- плеер ---------------- */

function stop() {
  attempt++;
  hls?.destroy();
  hls = null;
}

export function openChannel(i: number) {
  cur = (i + channels.length) % channels.length;
  srcIdx = 0;
  level = -1;
  srcPref = 0;
  const known = (channels[cur].res ?? []).filter((h): h is number => !!h);
  if (settings.quality === "low" && new Set(known).size >= 2) { // экономный режим: сразу самый лёгкий источник
    srcPref = Math.min(...known);
    srcIdx = Math.max(0, (channels[cur].res ?? []).indexOf(srcPref));
  }
  if (!channels[cur].adult) { try { localStorage.setItem("velvet.last", channels[cur].id); } catch { /* не страшно */ } } // взрослые не попадают в «Продолжить»
  drawRail();
  renderNow();
  renderGuide();
  paintFav();
  window.dispatchEvent(new Event("velvet:tv-start")); // радио уступает
  installTvMedia();
  void startSource();
}

export function leave() {
  stop();
  v.pause();
  v.removeAttribute("src");
  v.load();
  toggleGuide(false);
  closeMenus();
  if (document.fullscreenElement) void document.exitFullscreen();
}

function nextSource(reason: string) {
  if (srcIdx + 1 < channels[cur].sources.length) {
    srcIdx++;
    srcPref = 0;
    say("Подключаюсь…");
    void startSource();
  } else {
    stop();
    say(reason, 4000);
  }
}

/* у Rutube ссылка на эфир выдаётся отдельным запросом */
async function resolve(src: Source): Promise<string> {
  if (typeof src === "string") return src;
  const r = await fetch(viaProxy(`https://rutube.ru/api/play/options/${src.rutube}/?no_404=true&referer=https%3A%2F%2Frutube.ru`));
  const url = ((await r.json()) as { live_streams?: { hls?: { url: string }[] } }).live_streams?.hls?.[0]?.url;
  if (!url) throw new Error("эфир закрыт правообладателем");
  return url;
}

async function startSource() {
  stop();
  const mine = ++attempt;
  const src = channels[cur].sources[srcIdx];
  if (!src) return nextSource("Канал сейчас недоступен");
  let url: string;
  try {
    url = await resolve(src);
  } catch {
    if (mine === attempt) nextSource("Канал сейчас недоступен");
    return;
  }
  if (mine !== attempt) return;
  HlsCls ??= (await import("hls.js")).default;
  if (mine !== attempt) return;
  const Hls = HlsCls;
  const h = new Hls({
    lowLatencyMode: false, backBufferLength: 20, maxBufferLength: 24, liveSyncDurationCount: 3,
    abrEwmaDefaultEstimate: 8_000_000, startLevel: -1, manifestLoadingTimeOut: 6000, manifestLoadingMaxRetry: 1, levelLoadingTimeOut: 6000, levelLoadingMaxRetry: 1, fragLoadingTimeOut: 9000,
  });
  hls = h;
  lastTime = -1;
  stuckSince = performance.now();
  h.on(Hls.Events.MANIFEST_PARSED, () => {
    buildQuality();
    v.play().catch(() => undefined);
  });
  h.on(Hls.Events.LEVEL_SWITCHED, updateQualityLabel);
  h.on(Hls.Events.ERROR, (_e, d) => {
    if (!d.fatal || h !== hls) return;
    if (d.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
    else nextSource("Канал сейчас недоступен");
  });
  h.loadSource(viaProxy(url));
  h.attachMedia(v);
}

/* если картинка стоит на месте — сначала пробуем снова, потом следующий источник */
setInterval(() => {
  if (!(active() || inPip()) || !hls || v.paused) { stuckSince = performance.now(); return; }
  if (v.currentTime !== lastTime) { lastTime = v.currentTime; stuckSince = performance.now(); return; }
  const stuck = performance.now() - stuckSince;
  if (stuck > 12000) nextSource("Канал сейчас недоступен");
  else if (stuck > 6000) hls.startLoad();
}, 1000);

function togglePause() {
  if (v.paused) {
    if (hls && hls.liveSyncPosition) v.currentTime = hls.liveSyncPosition; // возвращаемся в прямой эфир
    v.play().catch(() => undefined);
  } else v.pause();
}
v.addEventListener("pause", () => flash("pause"));
v.addEventListener("play", () => flash("play"));
function flash(kind: "pause" | "play") {
  if (!hls || !active()) return;
  mark.className = `pause-mark ${kind}`;
  void mark.offsetWidth;
  mark.classList.add("flash");
}
v.addEventListener("click", () => { closeMenus(); togglePause(); });

/* ---------------- громкость ---------------- */

const ICON_HIGH = '<path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>';
const ICON_LOW = '<path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>';
const ICON_OFF = '<path d="M3 9v6h4l5 4V5L7 9H3zm13.6 .6L15.2 11l-1.4-1.4-1.4 1.4 1.4 1.4-1.4 1.4 1.4 1.4 1.4-1.4 1.4 1.4 1.4-1.4-1.4-1.4 1.4-1.4z"/>';

function paintVolume() {
  const level = v.muted ? 0 : v.volume;
  vol.value = String(level);
  vol.style.setProperty("--p", `${level * 100}%`);
  volIcon.innerHTML = level === 0 ? ICON_OFF : level < 0.5 ? ICON_LOW : ICON_HIGH;
}
function setVolume(x: number, announce = false) {
  v.volume = Math.min(1, Math.max(0, x));
  v.muted = v.volume === 0;
  try { localStorage.setItem("velvet.vol", String(v.volume)); } catch { /* не страшно */ }
  paintVolume();
  if (announce) say(v.muted ? "Звук выключен" : `Громкость ${Math.round(v.volume * 100)}%`, 1000);
}
function toggleMute() {
  v.muted = !v.muted;
  if (!v.muted && v.volume === 0) v.volume = 0.5;
  paintVolume();
  say(v.muted ? "Звук выключен" : "Звук включён", 1000);
}
btnVol.onclick = toggleMute;
vol.addEventListener("input", () => setVolume(Number(vol.value)));
app.addEventListener("wheel", (e) => { if (!(e.target as HTMLElement).closest(".rail, .guide, .menu")) setVolume(v.volume - Math.sign(e.deltaY) * 0.05, true); }, { passive: true });
{
  let saved = 1;
  try { saved = Number(localStorage.getItem("velvet.vol") ?? 1); } catch { /* ничего */ }
  v.volume = Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 1;
  paintVolume();
}

/* ---------------- качество ---------------- */

const qName = (l: number) => (hls && hls.levels[l] ? `${hls.levels[l].height}p` : "");

function buildQuality() {
  if (!hls) return;
  const res = channels[cur].res ?? [];
  const sourceHeights = [...new Set(res.filter((h): h is number => !!h))].sort((x, y) => y - x);
  const order = hls.levels.map((l, i) => ({ h: l.height || 0, i })).sort((x, y) => y.h - x.h);
  const multi = hls.levels.length >= 2;
  sourceMode = !multi && sourceHeights.length >= 2;
  qMenu.replaceChildren();
  const add = (label: string, hint: string, value: number, pick: (v: number) => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.dataset.level = String(value);
    const name = document.createElement("span");
    name.textContent = label;
    b.append(name);
    if (hint) {
      const small = document.createElement("small");
      small.textContent = hint;
      b.append(small);
    }
    b.onclick = () => { pick(value); closeMenus(); };
    qMenu.append(b);
  };
  const hintOf = (h: number) => (h >= 1080 ? "Full HD" : h >= 720 ? "HD" : "");
  if (multi) {
    add("Авто", "подбирается само", -1, setLevel);
    for (const o of order) add(`${o.h}p`, hintOf(o.h), o.i, setLevel);
    // качество по умолчанию из настроек
    if (settings.quality === "high") level = order[0].i;
    if (settings.quality === "low") level = (order.find((o) => o.h <= 480) ?? order[order.length - 1]).i;
    if (level !== -1) hls.currentLevel = level;
  } else if (sourceMode) {
    add("Авто", "подбирается само", 0, chooseSource);
    for (const h of sourceHeights) add(`${h}p`, hintOf(h), h, chooseSource);
  }
  // один поток и одно качество: выбирать не из чего, но текущее качество показываем
  btnQ.hidden = false;
  (btnQ as HTMLButtonElement).disabled = !multi && !sourceMode;
  btnQ.title = !multi && !sourceMode ? "У этого канала одно качество" : "";
  paintQuality();
}

function chooseSource(h: number) {
  const res = channels[cur].res ?? [];
  srcPref = h;
  srcIdx = h === 0 ? 0 : Math.max(0, res.indexOf(h));
  void startSource();
}

function setLevel(l: number) {
  level = l;
  if (hls) hls.currentLevel = l;
  paintQuality();
}

function paintQuality() {
  const chosen = sourceMode ? srcPref : level;
  qMenu.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.level) === chosen)));
  updateQualityLabel();
}

function updateQualityLabel() {
  if (!hls) return;
  if (hls.levels.length >= 2) {
    const now = qName(hls.currentLevel);
    qLabel.textContent = level === -1 ? (now ? `Авто · ${now}` : "Авто") : qName(level);
    return;
  }
  const h = channels[cur].res?.[srcIdx] || v.videoHeight || hls.levels[0]?.height || 0;
  const now = h ? `${h}p` : "";
  qLabel.textContent = sourceMode ? (srcPref ? `${srcPref}p` : now ? `Авто · ${now}` : "Авто") : now || "—";
}
v.addEventListener("loadedmetadata", updateQualityLabel);
v.addEventListener("resize", updateQualityLabel);

/* ---------------- что сейчас идёт ---------------- */

const programs = () => programsOf(channels[cur]);

function renderNow() {
  const ch = channels[cur];
  const now = Date.now();
  const list = programs();
  const p = list.find((x) => x.s <= now && now < x.e);
  const next = list.find((x) => x.s >= now);
  elName.textContent = ch.name;
  if (!p) {
    elTitle.textContent = ch.name;
    elTime.textContent = "Прямой эфир";
    elAge.textContent = "";
    elProgress.style.visibility = "hidden";
    elElapsed.textContent = "";
    elNext.textContent = "";
    return;
  }
  elTitle.textContent = p.t;
  if (p.t !== lastMedia) updateMedia();
  elTime.textContent = `${hhmm(p.s)} – ${hhmm(p.e)}`;
  elAge.textContent = p.a;
  elProgress.style.visibility = "visible";
  elBar.style.width = `${Math.min(100, Math.max(0, ((now - p.s) / (p.e - p.s)) * 100))}%`;
  elElapsed.textContent = `Идёт ${minutes(now - p.s)} · осталось ${minutes(p.e - now)}`;
  elNext.textContent = next ? `Далее в ${hhmm(next.s)} — ${next.t}` : "";
  if (now - lastProgress > 30000) { lastProgress = now; renderGuide(); }
}
setInterval(() => { if (active() || inPip()) renderNow(); }, 1000);
window.addEventListener("velvet:epg", () => { if (active()) { renderNow(); renderGuide(); } });

function renderGuide() {
  gName.textContent = channels[cur].name;
  const now = Date.now();
  const list = programs().filter((x) => x.e > now - 2 * 3600e3 && x.s < now + 24 * 3600e3);
  gList.replaceChildren();
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "empty";
    const title = document.createElement("strong");
    title.textContent = "Программы пока нет";
    const note = document.createElement("span");
    note.textContent = "Для этого канала расписание недоступно. Эфир идёт в прямом времени.";
    li.append(title, note);
    gList.append(li);
    return;
  }
  for (const p of list) {
    const state = p.e <= now ? "past" : p.s <= now ? "now" : "";
    const li = document.createElement("li");
    if (state) li.className = state;
    const time = document.createElement("time");
    time.textContent = hhmm(p.s);
    const box = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = p.t;
    box.append(title);
    if (p.d) {
      const info = document.createElement("span");
      info.textContent = p.d.length > 110 ? `${p.d.slice(0, 110)}…` : p.d;
      box.append(info);
    }
    if (state === "now") {
      const mini = document.createElement("div");
      mini.className = "mini";
      const fill = document.createElement("b");
      fill.style.width = `${Math.min(100, Math.max(0, ((now - p.s) / (p.e - p.s)) * 100))}%`;
      mini.append(fill);
      box.append(mini);
    }
    li.append(time, box);
    gList.append(li);
  }
  gList.querySelector(".now")?.scrollIntoView({ block: "center" });
}

/* ---------------- избранное, картинка в картинке, медиаклавиши ---------------- */

function paintFav() {
  const f = isFav(channels[cur].id);
  btnFav.setAttribute("aria-pressed", String(f));
  btnFav.setAttribute("aria-label", f ? "Убрать из избранного" : "В избранное");
}
btnFav.onclick = () => toggleFav(channels[cur].id);
window.addEventListener("velvet:fav", paintFav);

btnPip.hidden = !document.pictureInPictureEnabled;
btnPip.onclick = async () => {
  try {
    if (inPip()) await document.exitPictureInPicture();
    else await v.requestPictureInPicture();
  } catch { say("Картинка в картинке сейчас недоступна"); }
};
v.addEventListener("enterpictureinpicture", () => {
  btnPip.setAttribute("aria-pressed", "true");
  if (active()) hooks.back(); // эфир остаётся в маленьком окне, а главное окно возвращается к списку
});
v.addEventListener("leavepictureinpicture", () => {
  btnPip.setAttribute("aria-pressed", "false");
  // «вернуться на вкладку» или закрытие маленького окна: возвращаемся в обычный плеер с этим же каналом, эфир не прерываем
  if (!active() && !quietPip) {
    hooks.restore();
    if (v.paused) togglePause();
  }
});

let lastMedia = "";
function updateMedia() {
  if (!("mediaSession" in navigator)) return;
  const c = channels[cur];
  const now = Date.now();
  const show = programs().find((x) => x.s <= now && now < x.e);
  lastMedia = show?.t ?? "";
  const type = c.logo.endsWith(".jpeg") ? "image/jpeg" : "image/png";
  navigator.mediaSession.metadata = new MediaMetadata({
    title: show?.t ?? c.name,
    artist: c.name,
    album: "Velvet",
    artwork: !c.logo || c.logo.endsWith(".svg") ? [] : [{ src: new URL(c.logo, location.href).href, sizes: "512x512", type }],
  });
}
function installTvMedia() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const on = (action: MediaSessionAction, handler: () => void) => { try { ms.setActionHandler(action, handler); } catch { /* не поддерживается */ } };
  on("play", () => { if (v.paused) togglePause(); });
  on("pause", () => { if (!v.paused) v.pause(); });
  on("previoustrack", () => { if (active() || inPip()) openChannel(cur - 1); });
  on("nexttrack", () => { if (active() || inPip()) openChannel(cur + 1); });
  updateMedia();
}
if ("mediaSession" in navigator) {
  const state = () => { if (active() || inPip()) navigator.mediaSession.playbackState = v.paused ? "paused" : "playing"; };
  v.addEventListener("play", state);
  v.addEventListener("pause", state);
}

/* радио запустили — телевидение уступает (маленькое окно тоже закрываем, не возвращая плеер) */
let quietPip = false;
export function stopTv() {
  stop();
  v.pause();
  v.removeAttribute("src");
  v.load();
  if (inPip()) {
    quietPip = true;
    document.exitPictureInPicture().catch(() => undefined).finally(() => { quietPip = false; });
  }
}

/* ---------------- интерфейс ---------------- */

function drawRail() {
  rail.replaceChildren();
  channels.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = c.tile === "light" ? "ch light" : "ch";
    b.type = "button";
    b.title = c.name;
    b.setAttribute("aria-label", c.name);
    if (i === cur) b.setAttribute("aria-current", "true");
    if (c.logo) {
      const img = document.createElement("img");
      img.src = c.logo;
      img.alt = "";
      img.draggable = false;
      b.append(img);
    } else {
      b.textContent = c.name.slice(0, 2).toUpperCase();
      b.classList.add("mark");
      b.style.background = `hsl(${c.hue ?? 270} 45% 30%)`;
    }
    b.onclick = () => openChannel(i);
    rail.append(b);
  });
  rail.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
}

function closeMenus() {
  qMenu.classList.remove("open");
  btnQ.setAttribute("aria-expanded", "false");
}
function toggleGuide(open?: boolean) {
  guide.classList.toggle("open", open);
}
function poke() {
  app.classList.add("show");
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (qMenu.classList.contains("open") || guide.classList.contains("open") || v.paused) return;
    app.classList.remove("show");
  }, 2800);
}
export const pokeUi = poke;
app.addEventListener("mousemove", poke);

btnQ.onclick = (e) => {
  e.stopPropagation();
  const open = qMenu.classList.toggle("open");
  btnQ.setAttribute("aria-expanded", String(open));
};
$("btnGuide").onclick = () => toggleGuide();
$("gClose").onclick = () => toggleGuide(false);
$("btnBack").onclick = () => hooks.back();
$("btnFs").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : app.requestFullscreen());
v.addEventListener("dblclick", () => (document.fullscreenElement ? document.exitFullscreen() : app.requestFullscreen()));
document.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest(".qwrap")) closeMenus(); });

document.addEventListener("keydown", (e) => {
  if (!active()) return;
  poke();
  switch (e.key) {
    case " ": e.preventDefault(); togglePause(); break;
    case "f": case "F": document.fullscreenElement ? document.exitFullscreen() : app.requestFullscreen(); break;
    case "m": case "M": toggleMute(); break;
    case "ArrowLeft": setVolume(v.volume - 0.05, true); break;
    case "ArrowRight": setVolume(v.volume + 0.05, true); break;
    case "g": case "G": toggleGuide(); break;
    case "ArrowUp": openChannel(cur - 1); break;
    case "ArrowDown": openChannel(cur + 1); break;
    case "Escape":
      if (document.fullscreenElement) void document.exitFullscreen();
      else if (guide.classList.contains("open") || qMenu.classList.contains("open")) { closeMenus(); toggleGuide(false); }
      else hooks.back();
      break;
  }
});
