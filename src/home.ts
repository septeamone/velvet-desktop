import { channels, nowOf, hhmm, type Channel } from "./data";
import { isFav, toggleFav } from "./favs";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = "http://www.w3.org/2000/svg";

let query = "";
let openCb: (i: number) => void = () => undefined;

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
export function setQuery(q: string) {
  query = norm(q.trim());
}
export const hasQuery = () => query !== "";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function starIcon() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 17l-5.4 3 1.2-6L3.3 9.8l6.1-.7z");
  svg.append(path);
  return svg;
}

function card(c: Channel, onOpen: () => void) {
  const { cur } = nowOf(c);
  const b = el("button", "card");
  b.type = "button";
  b.setAttribute("aria-label", `${c.name}${cur ? `, сейчас: ${cur.t}` : ""}`);
  const logo = el("span", c.tile === "light" ? "logo light" : "logo");
  if (c.logo) {
    const img = el("img");
    img.src = c.logo;
    img.alt = "";
    img.draggable = false;
    logo.append(img);
  } else {
    logo.textContent = c.name.slice(0, 2).toUpperCase();
    logo.classList.add("mark");
    logo.style.background = `hsl(${c.hue ?? 270} 45% 30%)`;
  }
  const info = el("span", "info");
  info.append(el("span", "c-name", c.name), el("span", "c-title", cur ? cur.t : "Прямой эфир"));
  if (cur) {
    const now = Date.now();
    info.append(el("span", "c-time", `${hhmm(cur.s)} – ${hhmm(cur.e)}`));
    const bar = el("span", "c-bar");
    const fill = el("b");
    fill.style.width = `${Math.min(100, Math.max(0, ((now - cur.s) / (cur.e - cur.s)) * 100))}%`;
    bar.append(fill);
    b.append(logo, info, bar);
  } else {
    b.append(logo, info);
  }
  b.onclick = onOpen;
  return b;
}

/* карточка + звёздочка «в избранное» (кнопка в кнопке нельзя, поэтому они рядом) */
function tile(c: Channel, onOpen: () => void, draggable = false) {
  const wrap = el("div", "tile");
  wrap.dataset.id = c.id;
  if (draggable) wrap.dataset.sort = "1";
  const star = el("button", "star");
  star.type = "button";
  const fav = isFav(c.id);
  star.setAttribute("aria-pressed", String(fav));
  star.setAttribute("aria-label", fav ? `Убрать «${c.name}» из избранного` : `Добавить «${c.name}» в избранное`);
  star.append(starIcon());
  star.onclick = () => toggleFav(c.id);
  wrap.append(card(c, onOpen), star);
  return wrap;
}

export function renderHome(onOpen: (i: number) => void) {
  openCb = onOpen;
  const grid = $("grid"), resume = $("resume"), favs = $("favs");
  const idx = (c: Channel) => channels.indexOf(c);
  const searching = hasQuery();

  const list = channels.filter((c) => !searching || norm(`${c.name} ${nowOf(c).cur?.t ?? ""}`).includes(query));
  grid.replaceChildren(...list.map((c) => tile(c, () => openCb(idx(c)), !searching)));
  $("gridTitle").textContent = searching ? "Найдено" : "Сейчас в эфире";
  if (!list.length) {
    const empty = el("p", "nothing");
    empty.append(el("strong", undefined, "Ничего не найдено"), el("span", undefined, "Попробуйте другое название канала или передачи."));
    grid.append(empty);
  }

  resume.replaceChildren();
  favs.replaceChildren();
  resume.classList.remove("has");
  favs.classList.remove("has");
  if (searching) return;

  const favList = channels.filter((c) => isFav(c.id));
  if (favList.length) {
    favs.append(el("h2", undefined, "Избранное"));
    const g = el("div", "grid");
    g.append(...favList.map((c) => tile(c, () => openCb(idx(c)))));
    favs.append(g);
    favs.classList.add("has");
  }

  let last: string | null = null;
  try { last = localStorage.getItem("velvet.last"); } catch { /* ничего */ }
  const lc = channels.find((c) => c.id === last);
  if (lc) {
    resume.append(el("h2", undefined, "Продолжить"), tile(lc, () => openCb(idx(lc))));
    resume.classList.add("has");
  }
}
