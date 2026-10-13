/* Окно «Что нового»: человек видит только то, что изменилось между его версией и новой. */
import changelog from "./data/changelog.json";
import { newer } from "./version";

type Entry = { version: string; date?: string; items: string[] };
const bundled = changelog as Entry[];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SEEN = "velvet.seenVer";
let current = bundled[0]?.version ?? "";

/* строки заметок: маркеры «•», «-», «*» в начале убираем */
const lines = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*[•\-*]\s*/, "").trim()).filter(Boolean);

/* заметки релиза: блоки «## 1.0.3» и пункты под ними; без заголовков — это заметки одной версии `fallback` */
function parseNotes(notes: string | undefined, fallback: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!notes?.trim()) return out;
  const parts = notes.split(/^##\s*/m).slice(1);
  if (!parts.length) { if (fallback) out.set(fallback, lines(notes)); return out; }
  for (const p of parts) {
    const [head, ...rest] = p.split(/\r?\n/);
    out.set(head.trim(), lines(rest.join("\n")));
  }
  return out;
}

/* пункты по версиям: встроенная история, поверх неё заметки релиза (там могут быть версии новее установленной) */
function collect(notes: string | undefined, latest: string | undefined) {
  const all = new Map<string, string[]>(bundled.map((e) => [e.version, e.items]));
  for (const [v, items] of parseNotes(notes, latest)) if (items.length) all.set(v, items);
  return all;
}

/* есть ли что показать про версии после `since` до `until` (включительно) */
export function hasNews(since: string, until: string, notes?: string) {
  return range(collect(notes, until), since, until).length > 0;
}

function range(all: Map<string, string[]>, since: string, until: string) {
  return [...all]
    .filter(([v]) => newer(v, since) && !newer(v, until))
    .sort((a, b) => (newer(a[0], b[0]) ? -1 : 1));
}

const dateOf = (v: string) => bundled.find((e) => e.version === v)?.date;

function section(title: string, items: string[], date?: string) {
  const box = document.createElement("section");
  const h = document.createElement("h4");
  h.textContent = title;
  if (date) {
    const small = document.createElement("small");
    small.textContent = date;
    h.append(small);
  }
  const ul = document.createElement("ul");
  for (const t of items) {
    const li = document.createElement("li");
    li.textContent = t;
    ul.append(li);
  }
  box.append(h, ul);
  return box;
}

function open(title: string, blocks: Array<{ version: string; items: string[] }>) {
  $("newsTitle").textContent = title;
  const body = $("newsBody");
  body.replaceChildren();
  if (!blocks.length) body.textContent = "Подробностей пока нет.";
  // одна версия — просто список; несколько — по версиям, новые сверху
  else if (blocks.length === 1) body.append(section("Что изменилось", blocks[0].items, dateOf(blocks[0].version)));
  else for (const b of blocks) body.append(section(`Версия ${b.version}`, b.items, dateOf(b.version)));
  const dlg = $<HTMLDialogElement>("newsDlg");
  if (!dlg.open) dlg.showModal();
}

/* что изменилось после версии `since` до версии `until` (включительно) */
export function showChanges(since: string, until: string, notes?: string) {
  const blocks = range(collect(notes, until), since, until).map(([version, items]) => ({ version, items }));
  const first = blocks[blocks.length - 1]?.version;
  open(blocks.length > 1 ? `Что нового в версиях ${first}–${until}` : `Что нового в версии ${until}`, blocks);
}

/* кнопка в настройках: что нового именно в установленной версии */
export const showCurrent = () => open(`Что нового в версии ${current}`, bundled.filter((e) => e.version === current).map((e) => ({ version: e.version, items: e.items })));

export function bindNews() {
  $("btnNews").onclick = showCurrent;
  $("newsClose").onclick = () => $<HTMLDialogElement>("newsDlg").close();
}

/* после обновления один раз показываем, что изменилось с прошлой версии, которую человек видел; при самом первом запуске молчим */
export function initNews(installed: string) {
  current = installed;
  let seen: string | null = null;
  try { seen = localStorage.getItem(SEEN); } catch { /* не страшно */ }
  try { localStorage.setItem(SEEN, installed); } catch { /* не страшно */ }
  if (seen && newer(installed, seen) && hasNews(seen, installed)) setTimeout(() => showChanges(seen, installed), 1200);
}
