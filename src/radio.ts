/* Вкладка «Радио»: список станций, панель «Сейчас играет» с визуализатором и мини-плеер. */
import {
  stations, countries, shown, state, play, toggle, setQuality, setVolume, onRadio, spectrum, spectrumSize, setStepper, lastNotice, LIVE,
  type Station,
} from "./radio-engine";
import { fetchTrack } from "./nowplaying";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const shell = $("shell");
const regionNames = new Intl.DisplayNames(["ru"], { type: "region" });
const countryName = (cc: string) => { try { return regionNames.of(cc) ?? cc; } catch { return cc; } };
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/* ---------- избранное ---------- */
let fav = new Set<string>();
try { fav = new Set(JSON.parse(localStorage.getItem("velvet.rfav") ?? "[]") as string[]); } catch { /* пока пусто */ }
const saveFav = () => { try { localStorage.setItem("velvet.rfav", JSON.stringify([...fav])); } catch { /* не страшно */ } };
function toggleFav(id: string) {
  if (!fav.delete(id)) fav.add(id);
  saveFav();
  drawFilters();
  drawGrid();
  paintPanel();
}

/* ---------- фильтры ---------- */
let query = "";
let ccFilter = fav.size ? "FAV" : "RU";
let genreFilter = "";
let order: Station[] = [];

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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/* логотип станции или буквы на цветной плитке */
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
    box.classList.add("mark");
    box.style.background = `hsl(${s.hue} 45% 30%)`;
  }
  return box;
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
  $("rCountries").replaceChildren(
    chip(`Избранное${fav.size ? ` · ${fav.size}` : ""}`, ccFilter === "FAV", () => { ccFilter = "FAV"; genreFilter = ""; drawFilters(); drawGrid(); }),
    chip("Россия", ccFilter === "RU", () => { ccFilter = "RU"; genreFilter = ""; drawFilters(); drawGrid(); }, "RU"),
    chip("Все страны", ccFilter === "ALL", () => { ccFilter = "ALL"; genreFilter = ""; drawFilters(); drawGrid(); }),
    ...countries.filter((c) => c.cc !== "RU").map((c) => chip(countryName(c.cc), ccFilter === c.cc, () => { ccFilter = c.cc; genreFilter = ""; drawFilters(); drawGrid(); }, c.cc)),
  );
  const pool = stations.filter((s) => (ccFilter === "FAV" ? fav.has(s.id) : ccFilter === "ALL" || s.cc === ccFilter));
  const genres = new Map<string, string>();
  for (const s of pool) genres.set(s.g, s.gn);
  $("rGenres").replaceChildren(
    ...(genres.size > 1
      ? [
          chip("Все жанры", !genreFilter, () => { genreFilter = ""; drawFilters(); drawGrid(); }),
          ...[...genres].sort((a, b) => a[1].localeCompare(b[1], "ru")).map(([k, n]) => chip(n, genreFilter === k, () => { genreFilter = genreFilter === k ? "" : k; drawFilters(); drawGrid(); })),
        ]
      : []),
  );
}

/* названия песен в списке: только у станций с лёгким источником, раз в полминуты */
const listTracks = new Map<string, string>();
let listTimer = 0;
async function refreshListTracks() {
  if (shell.dataset.view !== "radio") return;
  const targets = visible().filter((s) => LIVE.has(s.id)).slice(0, 24);
  for (const s of targets) {
    try {
      const t = await fetchTrack(s.id);
      if (t) listTracks.set(s.id, t);
    } catch { /* без названия */ }
  }
  paintTracksInList();
}
function paintTracksInList() {
  document.querySelectorAll<HTMLElement>("#rGrid .scard").forEach((card) => {
    const id = card.dataset.id ?? "";
    const line = card.querySelector<HTMLElement>(".s-track");
    const t = id === state.station?.id && state.track ? state.track : listTracks.get(id);
    if (line && t) line.textContent = t;
  });
}

function stationCard(s: Station) {
  const card = el("div", "scard");
  card.dataset.id = s.id;
  const main = el("button", "s-main");
  main.type = "button";
  const info = el("span", "info");
  const maxK = shown(s).at(-1)!.k;
  const known = listTracks.get(s.id);
  info.append(el("span", "c-name", s.name), el("span", "c-title", `${s.gn} · до ${maxK} kbps`), el("span", "s-track", known ?? ""));
  main.append(logoOf(s, "logo"), info);
  const current = state.station?.id === s.id;
  if (current) {
    card.classList.add("now");
    const eq = el("span", `eq${state.status === "playing" && !state.paused ? " on" : ""}`);
    eq.append(el("i"), el("i"), el("i"));
    main.append(eq);
  }
  main.setAttribute("aria-label", `${s.name}, ${s.gn}`);
  main.onclick = () => play(s);
  const heart = el("button", "heart");
  heart.type = "button";
  heart.setAttribute("aria-pressed", String(fav.has(s.id)));
  heart.setAttribute("aria-label", fav.has(s.id) ? `Убрать «${s.name}» из избранного` : `Добавить «${s.name}» в избранное`);
  heart.innerHTML = HEART;
  heart.onclick = (e) => { e.stopPropagation(); toggleFav(s.id); };
  card.append(main, heart);
  return card;
}

function drawGrid() {
  const list = visible();
  order = list;
  const grid = $("rGrid");
  grid.replaceChildren();
  if (!list.length) {
    const empty = el("p", "r-empty");
    empty.append(
      el("strong", undefined, ccFilter === "FAV" && !query ? "Пока пусто" : "Ничего не найдено"),
      el("span", undefined, ccFilter === "FAV" && !query ? "Нажмите сердечко у станции, и она появится здесь." : "Попробуйте другое название, страну или жанр."),
    );
    grid.append(empty);
    return;
  }
  grid.append(...list.map(stationCard));
}

/* ---------- переключение станций кнопками «следующая/предыдущая» ---------- */
function step(dir: number) {
  const base = order.length ? order : stations;
  const i = base.findIndex((x) => x.id === state.station?.id);
  play(base[(i + dir + base.length) % base.length]);
}
setStepper(step);

/* ---------- значки ---------- */
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.4 5 6.6 5c2 0 3.5 1.1 4.4 2.6h2C13.9 6.1 15.4 5 17.4 5c3.2 0 5.1 3 3.9 6.3-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>';
const ICON_PLAY = '<path d="M8 5.5v13l11-6.5z"/>';
const ICON_PAUSE = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>';
const VOL_ON = '<path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>';

/* ---------- панель «Сейчас играет» и мини-плеер ---------- */
const panel = $("rPanel");
const mini = $("mini");

function statusText(): string {
  if (!state.station) return "Выберите станцию";
  if (state.status === "connecting") return "Подключаюсь…";
  if (state.status === "error") return "Станция недоступна";
  return state.paused ? "На паузе" : "В эфире";
}

function paintQualityButtons(host: HTMLElement, compact: boolean) {
  const s = state.station;
  host.replaceChildren();
  if (!s) return;
  const list = shown(s);
  host.hidden = list.length < 2;
  for (const q of list) {
    const b = el("button", compact ? "" : "q-btn");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(q.k === state.kbps));
    b.append(el("span", undefined, compact ? `${q.k} kbps` : String(q.k)), ...(compact ? [] : [el("small", undefined, "kbps")]));
    if (q.n) b.title = q.n;
    b.onclick = () => { setQuality(q.k); $("mQMenu").classList.remove("open"); };
    host.append(b);
  }
}

function paintPanel() {
  const s = state.station;
  panel.classList.toggle("empty", !s);
  panel.style.setProperty("--h", String(s?.hue ?? 285));
  $("pStatus").textContent = statusText();
  panel.dataset.status = s ? (state.paused && state.status === "playing" ? "paused" : state.status) : "idle";
  $("pName").textContent = s?.name ?? "Velvet Radio";
  const meta = $("pMeta");
  meta.replaceChildren();
  if (s) {
    const flag = el("img", "flag");
    flag.src = `/flags/${s.cc.toLowerCase()}.svg`;
    flag.alt = "";
    meta.append(flag, `${s.gn} · ${countryName(s.cc)}`);
  } else meta.textContent = "408 станций из России и 28 стран мира";
  $("pTrack").textContent = s ? state.track || (state.status === "playing" ? "Название песни недоступно" : "") : "Выберите станцию слева, и здесь появится, что играет.";
  const logo = $("pLogo");
  logo.replaceChildren(...(s ? [logoOf(s, "p-logo-in")] : []));
  paintQualityButtons($("pQ"), false);
  const playing = state.status === "connecting" || (state.status === "playing" && !state.paused);
  $("pPlayIcon").innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  $("pPlay").setAttribute("aria-label", playing ? "Пауза" : "Играть");
  const heart = $("pFav");
  const isFav = !!s && fav.has(s.id);
  heart.setAttribute("aria-pressed", String(isFav));
  heart.hidden = !s;
  ($("pVol") as HTMLInputElement).value = String(state.volume);
  $("pVol").style.setProperty("--p", `${state.volume * 100}%`);
}

function paintMini() {
  const s = state.station;
  const show = !!s && state.status !== "idle";
  mini.classList.toggle("open", show);
  shell.classList.toggle("has-mini", show);
  if (!s) return;
  mini.style.setProperty("--h", String(s.hue));
  $("mName").textContent = s.name;
  const t = $("mTrack");
  t.textContent = state.status === "connecting" ? "Подключаюсь…" : state.status === "error" ? "Станция недоступна" : state.track || s.gn;
  t.classList.toggle("err", state.status === "error");
  const mLogo = $("mLogo");
  mLogo.replaceChildren(...logoOf(s, "x").childNodes);
  mLogo.className = `logo sm${s.logo ? "" : " mark"}`;
  mLogo.style.background = s.logo ? "" : `hsl(${s.hue} 45% 30%)`;
  const playing = state.status === "connecting" || (state.status === "playing" && !state.paused);
  $("mPlayIcon").innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  $("mPlay").setAttribute("aria-label", playing ? "Пауза" : "Играть");
  const q = $("mQ");
  const list = shown(s);
  q.hidden = list.length < 2;
  q.textContent = state.kbps ? `${state.kbps} kbps` : "Качество";
  paintQualityButtons($("mQMenu"), true);
  ($("mVol") as HTMLInputElement).value = String(state.volume);
  $("mVol").style.setProperty("--p", `${state.volume * 100}%`);
  mini.classList.toggle("live", playing && state.status === "playing");
}

let paintQueued = false;
function paintAll() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paintPanel();
    paintMini();
    if (shell.dataset.view === "radio") { drawGrid(); paintTracksInList(); }
  });
}

/* ---------- визуализатор ---------- */
const canvas = $("pViz") as HTMLCanvasElement;
const c2d = canvas.getContext("2d")!;
const BARS = 44;
const level = new Float32Array(BARS);
let freq = new Uint8Array(128);

function drawViz() {
  requestAnimationFrame(drawViz);
  if (shell.dataset.view !== "radio" || document.hidden || !panel.offsetParent) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(rect.width * dpr), H = Math.round(rect.height * dpr);
  if (!W || !H) return;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  c2d.clearRect(0, 0, W, H);
  if (freq.length !== spectrumSize()) freq = new Uint8Array(spectrumSize());
  const live = spectrum(freq);
  const n = freq.length * 0.72;
  const hue = state.station?.hue ?? 285;
  const gap = 4 * dpr;
  const bw = (W - gap * (BARS - 1)) / BARS;
  const grad = c2d.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, `hsl(${hue} 80% 52%)`);
  grad.addColorStop(1, `hsl(${(hue + 38) % 360} 95% 70%)`);
  c2d.fillStyle = grad;
  for (let i = 0; i < BARS; i++) {
    let v = 0;
    if (live) {
      const lo = Math.floor(Math.pow(i / BARS, 1.6) * n);
      const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / BARS, 1.6) * n));
      let sum = 0;
      for (let b = lo; b < hi; b++) sum += freq[b];
      v = sum / (hi - lo) / 255;
      v = Math.pow(v, 1.15);
    }
    level[i] = Math.max(v, level[i] * 0.9);
    const h = Math.max(4 * dpr, level[i] * H);
    const x = i * (bw + gap);
    const r = Math.min(bw / 2, 6 * dpr);
    c2d.beginPath();
    c2d.roundRect(x, H - h, bw, h, r);
    c2d.fill();
  }
}

/* ---------- запуск ---------- */
let ready = false;
export function renderRadio() {
  if (!ready) return;
  drawFilters();
  drawGrid();
  paintPanel();
  void refreshListTracks();
}

export function initRadio() {
  if (ready) return;
  ready = true;
  $<HTMLInputElement>("rSearch").addEventListener("input", (e) => { query = (e.target as HTMLInputElement).value; drawGrid(); void refreshListTracks(); });
  $("pPlay").onclick = () => { if (state.station) toggle(); };
  $("pPrev").onclick = () => step(-1);
  $("pNext").onclick = () => step(1);
  $("pFav").onclick = () => { if (state.station) toggleFav(state.station.id); };
  $("mPlay").onclick = () => toggle();
  $("mPrev").onclick = () => step(-1);
  $("mNext").onclick = () => step(1);
  $("mQ").onclick = (e) => { e.stopPropagation(); $("mQMenu").classList.toggle("open"); };
  $("mOpen").onclick = () => window.dispatchEvent(new Event("velvet:open-radio"));
  document.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest(".mqwrap")) $("mQMenu").classList.remove("open"); });
  for (const id of ["pVol", "mVol"]) $<HTMLInputElement>(id).addEventListener("input", (e) => setVolume(Number((e.target as HTMLInputElement).value)));
  $("pVolIcon").innerHTML = VOL_ON;
  $("mVolIcon").innerHTML = VOL_ON;
  window.addEventListener("velvet:rnotice", (e) => {
    const t = $("rToast");
    t.textContent = (e as CustomEvent<string>).detail || lastNotice();
    t.classList.add("on");
    setTimeout(() => t.classList.remove("on"), 3200);
  });
  document.addEventListener("keydown", (e) => {
    if (shell.dataset.view !== "radio") return;
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === " " && tag !== "INPUT" && tag !== "BUTTON") { e.preventDefault(); if (state.station) toggle(); }
  });
  onRadio(paintAll);
  clearInterval(listTimer);
  listTimer = window.setInterval(() => void refreshListTracks(), 30000);
  requestAnimationFrame(drawViz);
  renderRadio();
  paintMini();
}
