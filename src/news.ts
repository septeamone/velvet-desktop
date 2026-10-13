/* Окно «Что нового»: история версий, заметки найденного обновления и однократный показ после обновления. */
import changelog from "./data/changelog.json";

type Entry = { version: string; date?: string; items: string[] };
const log = changelog as Entry[];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SEEN = "velvet.seenVer";

/* заметки из релиза: строки, возможно с маркерами «•», «-», «*» в начале */
const lines = (notes: string) => notes.split(/\r?\n/).map((l) => l.replace(/^\s*[•\-*]\s*/, "").trim()).filter(Boolean);

const entryItems = (version: string) => log.find((e) => e.version === version)?.items ?? [];

/* есть ли что показать про эту версию (из релиза или из встроенной истории) */
export const hasNews = (version: string, notes?: string) => Boolean(notes?.trim()) || entryItems(version).length > 0;

function list(items: string[]) {
  const ul = document.createElement("ul");
  for (const t of items) {
    const li = document.createElement("li");
    li.textContent = t;
    ul.append(li);
  }
  return ul;
}

function section(title: string, items: string[], date?: string) {
  const box = document.createElement("section");
  const h = document.createElement("h4");
  h.textContent = title;
  if (date) {
    const small = document.createElement("small");
    small.textContent = date;
    h.append(small);
  }
  box.append(h, list(items));
  return box;
}

/* без параметров — вся история; с версией — только она (заметки из релиза или из встроенной истории) */
export function showNews(opts?: { version?: string; notes?: string }) {
  const body = $("newsBody");
  body.replaceChildren();
  if (opts?.version) {
    $("newsTitle").textContent = `Что нового в версии ${opts.version}`;
    const items = opts.notes?.trim() ? lines(opts.notes) : entryItems(opts.version);
    body.append(list(items.length ? items : ["Подробностей пока нет."]));
  } else {
    $("newsTitle").textContent = "Что нового";
    for (const e of log) body.append(section(`Версия ${e.version}`, e.items, e.date));
  }
  const dlg = $<HTMLDialogElement>("newsDlg");
  if (!dlg.open) dlg.showModal();
}

export function bindNews() {
  $("btnNews").onclick = () => showNews();
  $("newsClose").onclick = () => $<HTMLDialogElement>("newsDlg").close();
}

/* после обновления один раз показываем, что изменилось; при самом первом запуске молчим */
export function initNews(current: string) {
  let seen: string | null = null;
  try { seen = localStorage.getItem(SEEN); } catch { /* не страшно */ }
  try { localStorage.setItem(SEEN, current); } catch { /* не страшно */ }
  if (seen && seen !== current && entryItems(current).length) setTimeout(() => showNews({ version: current }), 1200);
}
