import { channels, nowOf, hhmm, type Channel } from "./data";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function card(c: Channel, onOpen: () => void) {
  const { cur } = nowOf(c);
  const b = el("button", "card");
  b.type = "button";
  b.setAttribute("aria-label", `${c.name}${cur ? `, сейчас: ${cur.t}` : ""}`);
  const logo = el("span", c.tile === "light" ? "logo light" : "logo");
  const img = el("img");
  img.src = c.logo;
  img.alt = "";
  img.draggable = false;
  logo.append(img);
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

export function renderHome(onOpen: (i: number) => void) {
  const grid = $("grid"), resume = $("resume");
  grid.replaceChildren(...channels.map((c, i) => card(c, () => onOpen(i))));
  let last: string | null = null;
  try { last = localStorage.getItem("velvet.last"); } catch { /* ничего */ }
  const li = channels.findIndex((c) => c.id === last);
  resume.replaceChildren();
  if (li >= 0) {
    resume.append(el("h2", undefined, "Продолжить"), card(channels[li], () => onOpen(li)));
    resume.classList.add("has");
  } else resume.classList.remove("has");
}
