/* Вкладка «Радио»: список станций, панель «Сейчас играет» с визуализатором и мини-плеер. */
import {
  stations, countries, shown, state, play, toggle, setQuality, setVolume, toggleMute, onRadio, levels, setStepper, lastNotice, LIVE,
  EQ_LABELS, EQ_MAX, getEq, setEq, resetEq,
  type Station,
} from "./radio-engine";
import { fetchTrack } from "./nowplaying";
import { enableSort, isSorting } from "./sortable";
import { openExternal } from "./tauri";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const shell = $("shell");
const regionNames = new Intl.DisplayNames(["ru"], { type: "region" });
const SHORT: Record<string, string> = { US: "США", GB: "Великобритания", KR: "Южная Корея", AE: "ОАЭ" };
const countryName = (cc: string) => { try { return SHORT[cc] ?? regionNames.of(cc) ?? cc; } catch { return cc; } };
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/* ---------- избранное и свой порядок ---------- */
let fav = new Set<string>();
try { fav = new Set(JSON.parse(localStorage.getItem("velvet.rfav") ?? "[]") as string[]); } catch { /* пока пусто */ }
const saveFav = () => { try { localStorage.setItem("velvet.rfav", JSON.stringify([...fav])); } catch { /* не страшно */ } };

const ORDER_KEY = "velvet.rorder";
let ord: string[] = [];
const loadOrder = () => { try { ord = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as string[]; } catch { ord = []; } };
loadOrder();
const rank = new Map<string, number>();
function sortedAll(): Station[] {
  rank.clear();
  ord.forEach((id, i) => rank.set(id, i));
  const base = new Map(stations.map((s, i) => [s.id, i]));
  return [...stations].sort((a, b) => (rank.get(a.id) ?? 10000 + base.get(a.id)!) - (rank.get(b.id) ?? 10000 + base.get(b.id)!));
}

/* новый порядок видимых станций занимает те же места в общем списке */
function applyOrder(ids: string[]) {
  const all = sortedAll().map((s) => s.id);
  const set = new Set(ids);
  const slots = all.flatMap((id, i) => (set.has(id) ? [i] : []));
  const next = [...all];
  slots.forEach((pos, k) => { next[pos] = ids[k]; });
  ord = next;
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(ord)); } catch { /* не страшно */ }
  order = visible();
}

function toggleFav(id: string) {
  if (!fav.delete(id)) fav.add(id);
  saveFav();
  drawFilters();
  drawGrid();
  paintPanel();
}

/* ---------- фильтры: страна, жанр, избранное, поиск ---------- */
let query = "";
let favOnly = fav.size > 0;
let cc = "RU";
let genre = "";
let order: Station[] = [];

function pool(): Station[] {
  return stations.filter((s) => (favOnly ? fav.has(s.id) : cc === "ALL" || s.cc === cc));
}

function visible(): Station[] {
  const q = norm(query.trim());
  return sortedAll().filter((s) => {
    if (favOnly ? !fav.has(s.id) : cc !== "ALL" && s.cc !== cc) return false;
    if (genre && s.g !== genre) return false;
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

function flagImg(code: string) {
  const f = el("img", "flag");
  f.src = `/flags/${code.toLowerCase()}.svg`;
  f.alt = "";
  return f;
}

/* логотип станции или буквы на цветной плитке */
function logoOf(s: Station, cls: string) {
  const box = el("span", cls);
  if (s.logo) {
    const img = el("img");
    img.src = `/radio/${s.id}.webp`;
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

/* строка меню: подпись, число станций, отметка выбранного */
function option(label: string, count: number, active: boolean, onPick: () => void, flag?: string) {
  const b = el("button", "opt");
  b.type = "button";
  b.setAttribute("role", "option");
  b.setAttribute("aria-selected", String(active));
  if (flag) b.append(flagImg(flag));
  b.append(el("span", "opt-name", label), el("small", undefined, String(count)));
  b.onclick = () => { onPick(); closePops(); };
  return b;
}

function closePops() {
  document.querySelectorAll(".pop.open").forEach((p) => p.classList.remove("open"));
  document.querySelectorAll(".f-btn[aria-expanded=true]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

function drawFilters() {
  // кнопки в панели инструментов
  const fFav = $("fFav");
  fFav.setAttribute("aria-pressed", String(favOnly));
  fFav.querySelector("span")!.textContent = fav.size ? `Избранное · ${fav.size}` : "Избранное";
  const fCountry = $("fCountry");
  fCountry.replaceChildren();
  if (!favOnly && cc !== "ALL") fCountry.append(flagImg(cc));
  fCountry.append(el("span", undefined, favOnly || cc === "ALL" ? "Все страны" : countryName(cc)), el("i", "caret"));
  const genres = new Map<string, { name: string; n: number }>();
  for (const s of pool()) genres.set(s.g, { name: s.gn, n: (genres.get(s.g)?.n ?? 0) + 1 });
  const fGenre = $("fGenre");
  fGenre.hidden = genres.size < 2;
  fGenre.replaceChildren(el("span", undefined, genre && genres.has(genre) ? genres.get(genre)!.name : "Все жанры"), el("i", "caret"));
  fGenre.classList.toggle("on", !!genre);
  fCountry.classList.toggle("on", !favOnly && cc !== "RU");

  // выпадающие списки
  const rows = [
    option("Все страны", stations.length, !favOnly && cc === "ALL", () => { favOnly = false; cc = "ALL"; genre = ""; refresh(); }),
    option("Россия", stations.filter((s) => s.cc === "RU").length, !favOnly && cc === "RU", () => { favOnly = false; cc = "RU"; genre = ""; refresh(); }, "RU"),
    ...countries.filter((c) => c.cc !== "RU").map((c) => option(countryName(c.cc), stations.filter((s) => s.cc === c.cc).length, !favOnly && cc === c.cc, () => { favOnly = false; cc = c.cc; genre = ""; refresh(); }, c.cc)),
  ];
  $("pCountry").replaceChildren(...rows);
  $("pGenre").replaceChildren(
    option("Все жанры", pool().length, !genre, () => { genre = ""; refresh(); }),
    ...[...genres].sort((a, b) => a[1].name.localeCompare(b[1].name, "ru")).map(([k, v]) => option(v.name, v.n, genre === k, () => { genre = k; refresh(); })),
  );
}

function refresh() {
  drawFilters();
  drawGrid();
  void refreshListTracks();
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
  if (!query.trim()) card.dataset.sort = "1";
  const main = el("button", "s-main");
  main.type = "button";
  const info = el("span", "info");
  const maxK = shown(s)[shown(s).length - 1].k;
  info.append(el("span", "c-name", s.name), el("span", "c-title", `${s.gn} · до ${maxK} kbps`), el("span", "s-track", listTracks.get(s.id) ?? ""));
  main.append(logoOf(s, "logo"), info);
  if (state.station?.id === s.id) {
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
  if (isSorting()) return;
  const list = visible();
  order = list;
  const grid = $("rGrid");
  grid.replaceChildren();
  if (!list.length) {
    const empty = el("p", "r-empty");
    const noFav = favOnly && !query.trim();
    empty.append(el("strong", undefined, noFav ? "Пока пусто" : "Ничего не найдено"), el("span", undefined, noFav ? "Нажмите сердечко у станции, и она появится здесь." : "Попробуйте другое название, страну или жанр."));
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
const VOL_HIGH = '<path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>';
const VOL_LOW = '<path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>';
const VOL_OFF = '<path d="M3 9v6h4l5 4V5L7 9H3zm13.6 .6L15.2 11l-1.4-1.4-1.4 1.4 1.4 1.4-1.4 1.4 1.4 1.4 1.4-1.4 1.4 1.4 1.4-1.4-1.4-1.4 1.4-1.4z"/>';

/* громкость: ползунок, процент, значок по уровню; везде одинаково (панель и мини-плеер) */
function paintVolume() {
  const v = state.volume;
  for (const [slider, icon, btn] of [["pVol", "pVolIcon", "pVolBtn"], ["mVol", "mVolIcon", "mVolBtn"]] as const) {
    ($(slider) as HTMLInputElement).value = String(v);
    $(slider).style.setProperty("--p", `${v * 100}%`);
    $(icon).innerHTML = v === 0 ? VOL_OFF : v < 0.5 ? VOL_LOW : VOL_HIGH;
    $(btn).setAttribute("aria-label", v === 0 ? "Включить звук" : "Выключить звук");
  }
  $("pPct").textContent = `${Math.round(v * 100)}%`;
}

/* ---------- эквалайзер: окошко с шестью полосами (кнопка есть и в панели, и в мини-плеере) ---------- */
function initEq() {
  const box = $("eq");
  const sliders = EQ_LABELS.map((label, i) => {
    const wrap = document.createElement("label");
    wrap.className = "eq-band";
    const out = document.createElement("output");
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(-EQ_MAX);
    input.max = String(EQ_MAX);
    input.step = "1";
    input.setAttribute("aria-label", `${label} Гц`);
    const name = document.createElement("span");
    name.textContent = label;
    wrap.append(out, input, name);
    $("eqBands").append(wrap);
    input.addEventListener("input", () => { setEq(i, Number(input.value)); paint(); });
    input.addEventListener("dblclick", () => { setEq(i, 0); paint(); });
    return { input, out };
  });
  const paint = () => getEq().forEach((g, i) => {
    const { input, out } = sliders[i];
    const p = ((g + EQ_MAX) / (2 * EQ_MAX)) * 100;
    input.value = String(g);
    input.style.setProperty("--lo", `${Math.min(p, 50)}%`);
    input.style.setProperty("--hi", `${Math.max(p, 50)}%`);
    out.textContent = g > 0 ? `+${g}` : String(g);
  });
  const show = (open: boolean) => {
    box.hidden = !open;
    for (const id of ["pEq", "mEq"]) $(id).setAttribute("aria-expanded", String(open));
    if (open) paint();
  };
  for (const id of ["pEq", "mEq"]) $(id).addEventListener("click", () => show(box.hidden === true));
  $("eqClose").addEventListener("click", () => show(false));
  $("eqReset").addEventListener("click", () => { resetEq(); paint(); });
  document.addEventListener("click", (e) => { if (!box.hidden && !(e.target as HTMLElement).closest("#eq, #pEq, #mEq")) show(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") show(false); });
  new MutationObserver(() => show(false)).observe(shell, { attributes: true, attributeFilter: ["data-view"] }); // ушли с радио — окошко закрываем
  paint();
}

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
  if (s) meta.append(flagImg(s.cc), `${s.gn} · ${countryName(s.cc)}`);
  else meta.textContent = `${stations.length} станций из России и 28 стран мира`;
  $("pTrack").textContent = s ? state.track || (state.status === "playing" ? "Название песни недоступно" : "") : "Выберите станцию слева, и здесь появится, что играет.";
  const link = !!s && state.status === "playing" && !!state.track; // название песни — ссылка на поиск в Google
  const trackRow = $("pTrackRow");
  trackRow.classList.toggle("link", link);
  trackRow.tabIndex = link ? 0 : -1;
  trackRow.setAttribute("role", link ? "link" : "presentation");
  trackRow.title = link ? "Найти в Google" : "";
  $("pLogo").replaceChildren(...(s ? [logoOf(s, "p-logo-in")] : []));
  paintQualityButtons($("pQ"), false);
  const playing = state.status === "connecting" || (state.status === "playing" && !state.paused);
  $("pPlayIcon").innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  $("pPlay").setAttribute("aria-label", playing ? "Пауза" : "Играть");
  const heart = $("pFav");
  heart.setAttribute("aria-pressed", String(!!s && fav.has(s.id)));
  heart.hidden = !s;
  paintVolume();
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
  q.hidden = shown(s).length < 2;
  q.textContent = state.kbps ? `${state.kbps} kbps` : "Качество";
  paintQualityButtons($("mQMenu"), true);
  paintVolume();
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

/* ---------- визуализатор: та же тонкая светящаяся линия, что в расширении ---------- */
const canvas = $("pViz") as HTMLCanvasElement;
const g = canvas.getContext("2d")!;
const BANDS = 32;
const lv = new Float32Array(BANDS), target = new Float32Array(BANDS), shownV = new Float32Array(BANDS), slow = new Float32Array(BANDS);
let c1 = "#ff5e78", c2 = "#ff9f43", frame = 0;

function drawViz() {
  requestAnimationFrame(drawViz);
  if (shell.dataset.view !== "radio" || document.hidden || !panel.offsetParent) return;
  const w = canvas.clientWidth, h = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  if (frame++ % 90 === 0) {
    const css = getComputedStyle(document.documentElement);
    c1 = css.getPropertyValue("--viz1").trim() || c1;
    c2 = css.getPropertyValue("--viz2").trim() || c2;
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  // бас громче верхов, поэтому верхние полосы слегка усиливаем
  const live = levels(lv);
  for (let i = 0; i < BANDS; i++) target[i] = live ? Math.min(1, lv[i] * (0.7 + (1.3 * i) / BANDS)) : 0;

  // линия «танцует» по изменениям: быстрый подъём на всплеске, мягкий спад, отсчёт — от долгого среднего каждой полосы
  for (let i = 0; i < BANDS; i++) {
    shownV[i] += (target[i] - shownV[i]) * (target[i] > shownV[i] ? 0.5 : 0.16);
    slow[i] += (shownV[i] - slow[i]) * 0.012;
  }
  let pts = Array.from(shownV, (v, i) => (v - slow[i]) * 4.6);
  pts = pts.map((v, i) => (pts[i - 1] ?? v) * 0.25 + v * 0.5 + (pts[i + 1] ?? v) * 0.25);

  const mid = h / 2, amp = h / 2 - 4, pad = 6, step = (w - pad * 2) / (BANDS - 1);
  const xy = pts.map((v, i) => [pad + i * step, mid - Math.max(-1, Math.min(1, v * Math.sin((Math.PI * i) / (BANDS - 1)) ** 0.6)) * amp] as [number, number]);
  g.beginPath();
  g.moveTo(xy[0][0], xy[0][1]);
  for (let i = 1; i < xy.length - 1; i++) {
    const [x, y] = xy[i], [nx, ny] = xy[i + 1];
    g.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  g.lineTo(...xy[xy.length - 1]);
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "transparent");
  grad.addColorStop(0.18, c1);
  grad.addColorStop(0.82, c2);
  grad.addColorStop(1, "transparent");
  g.strokeStyle = grad;
  g.lineWidth = 2.5;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.globalAlpha = 0.75;
  g.shadowBlur = 10;
  g.shadowColor = c1;
  g.stroke();
  g.globalAlpha = 1;
  g.shadowBlur = 0;
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
  $("fFav").onclick = () => { favOnly = !favOnly; genre = ""; closePops(); refresh(); };
  for (const [btn, pop] of [["fCountry", "pCountry"], ["fGenre", "pGenre"]] as const) {
    $(btn).onclick = (e) => {
      e.stopPropagation();
      const open = !$(pop).classList.contains("open");
      closePops();
      $(pop).classList.toggle("open", open);
      $(btn).setAttribute("aria-expanded", String(open));
    };
  }
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".f-wrap")) closePops();
    if (!(e.target as HTMLElement).closest(".mqwrap")) $("mQMenu").classList.remove("open");
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePops(); });

  const openSearch = () => { if (state.status === "playing" && state.track) openExternal(`https://www.google.com/search?q=${encodeURIComponent(state.track)}`); };
  $("pTrackRow").addEventListener("click", openSearch);
  $("pTrackRow").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSearch(); } });
  $("pPlay").onclick = () => { if (state.station) toggle(); };
  $("pPrev").onclick = () => step(-1);
  $("pNext").onclick = () => step(1);
  $("pFav").onclick = () => { if (state.station) toggleFav(state.station.id); };
  $("mPlay").onclick = () => toggle();
  $("mPrev").onclick = () => step(-1);
  $("mNext").onclick = () => step(1);
  $("mQ").onclick = (e) => { e.stopPropagation(); $("mQMenu").classList.toggle("open"); };
  $("mOpen").onclick = () => window.dispatchEvent(new Event("velvet:open-radio"));
  for (const id of ["pVol", "mVol"]) $<HTMLInputElement>(id).addEventListener("input", (e) => setVolume(Number((e.target as HTMLInputElement).value)));
  $("pVolBtn").onclick = toggleMute;
  $("mVolBtn").onclick = toggleMute;
  paintVolume();
  initEq();
  // колесо мыши над панелью меняет громкость, стрелки влево/вправо тоже
  panel.addEventListener("wheel", (e) => { setVolume(state.volume - Math.sign(e.deltaY) * 0.05); }, { passive: true });
  window.addEventListener("velvet:rnotice", (e) => {
    const t = $("rToast");
    t.textContent = (e as CustomEvent<string>).detail || lastNotice();
    t.classList.add("on");
    setTimeout(() => t.classList.remove("on"), 3200);
  });
  window.addEventListener("velvet:order-reset", () => { loadOrder(); if (shell.dataset.view === "radio") { drawGrid(); } });
  document.addEventListener("keydown", (e) => {
    if (shell.dataset.view !== "radio") return;
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === " " && tag !== "INPUT" && tag !== "BUTTON") { e.preventDefault(); if (state.station) toggle(); }
    if (tag !== "INPUT" && e.key === "ArrowLeft") setVolume(state.volume - 0.05);
    if (tag !== "INPUT" && e.key === "ArrowRight") setVolume(state.volume + 0.05);
    if (tag !== "INPUT" && (e.key === "m" || e.key === "M")) toggleMute();
  });

  enableSort($("rGrid"), ".scard", (ids) => applyOrder(ids));
  onRadio(paintAll);
  clearInterval(listTimer);
  listTimer = window.setInterval(() => void refreshListTracks(), 30000);
  requestAnimationFrame(drawViz);
  renderRadio();
  paintMini();
}
