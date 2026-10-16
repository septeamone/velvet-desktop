import "./styles.css";
import { initNet } from "./net";
import { channels, rebuildChannels, saveOrder, resetOrder, loadExtraChannels } from "./data";
import { enableSort, isSorting } from "./sortable";
import { addCustom, loadCustom, removeCustom } from "./custom";
import { loadSettings, setSetting, settings, onSetting, type Settings } from "./settings";
import { renderHome, setQuery } from "./home";
import { initUpdater } from "./updater";
import { startEpg } from "./epg";
import { openChannel, leave, hooks, pokeUi, inPip, stopTv } from "./player";

type View = "home" | "radio" | "settings" | "player";
const shell = document.getElementById("shell")!;
let tab: "tv" | "radio" = "tv";

/* радио подгружается при первом открытии вкладки, чтобы телевидение стартовало быстрее */
let radio: typeof import("./radio") | null = null;
async function ensureRadio() {
  if (!radio) {
    radio = await import("./radio");
    radio.initRadio();
  }
  return radio;
}

function show(view: View) {
  shell.dataset.view = view;
  document.querySelectorAll<HTMLElement>("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(view !== "settings" && b.dataset.tab === tab)));
  document.getElementById("btnSettings")!.setAttribute("aria-pressed", String(view === "settings"));
  if (view === "home") renderHome(play);
  if (view === "radio") void ensureRadio().then((r) => r.renderRadio());
}

function play(i: number) {
  show("player");
  openChannel(i);
  pokeUi();
}

window.addEventListener("velvet:radio-start", () => stopTv());
window.addEventListener("velvet:open-radio", () => { tab = "radio"; show("radio"); });
hooks.restore = () => { show("player"); pokeUi(); };
hooks.back = () => { if (!inPip()) leave(); show(tab === "tv" ? "home" : "radio"); };

document.querySelectorAll<HTMLElement>("#tabs button").forEach((b) => {
  b.onclick = () => { tab = b.dataset.tab as "tv" | "radio"; show(tab === "tv" ? "home" : "radio"); };
});
document.getElementById("btnSettings")!.onclick = () => show(shell.dataset.view === "settings" ? (tab === "tv" ? "home" : "radio") : "settings");

/* настройки: все переключатели собираются одинаково */
document.querySelectorAll<HTMLElement>(".seg[data-key]").forEach((seg) => {
  const key = seg.dataset.key as keyof Settings;
  const paint = () => seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === settings[key])));
  seg.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    if (key === "adult" && b.dataset.value === "on" && !confirm("Показывать каналы для взрослых?\nВам должно быть 18 лет или больше.")) return;
    setSetting(key, b.dataset.value as never);
  }));
  onSetting((k) => { if (k === key) paint(); });
  paint();
});

setInterval(() => { if (shell.dataset.view === "home" && !isSorting()) renderHome(play); }, 30000);
window.addEventListener("velvet:epg", () => { if (shell.dataset.view === "home" && !isSorting()) renderHome(play); });
window.addEventListener("velvet:fav", () => { if (shell.dataset.view === "home" && !isSorting()) renderHome(play); });

/* поиск: набираешь — список сразу сужается; Ctrl+K или «/» — перейти в поиск, Esc — очистить */
const search = document.getElementById("search") as HTMLInputElement;
search.addEventListener("input", () => { setQuery(search.value); renderHome(play); });
search.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { search.value = ""; setQuery(""); renderHome(play); search.blur(); }
});
document.addEventListener("keydown", (e) => {
  if (shell.dataset.view !== "home") return;
  const typing = document.activeElement instanceof HTMLInputElement;
  if ((e.ctrlKey && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
    e.preventDefault();
    search.focus();
    search.select();
  }
});

loadSettings();
rebuildChannels();
onSetting((k) => { if (k === "adult") rebuildChannels(); });
document.querySelectorAll(".seg[data-key]").forEach((seg) => {
  const key = (seg as HTMLElement).dataset.key as keyof Settings;
  seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === settings[key])));
});

void initNet().then(() => {
  void loadExtraChannels();
  void initUpdater();
  startEpg();
  let last: string | null = null;
  try { last = localStorage.getItem("velvet.last"); } catch { /* ничего */ }
  const li = channels.findIndex((c) => c.id === last);
  if (settings.start === "last" && li >= 0) play(li);
  else show("home");
});

/* свои каналы: список в настройках и окно добавления */
const customList = document.getElementById("customList") as HTMLUListElement;
function drawCustom() {
  customList.replaceChildren(
    ...loadCustom().map((c) => {
      const li = document.createElement("li");
      const info = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = c.name;
      info.append(name);
      if (c.adult) {
        const tag = document.createElement("em");
        tag.textContent = "18+";
        info.append(tag);
      }
      const url = document.createElement("small");
      url.textContent = c.url.length > 60 ? `${c.url.slice(0, 57)}…` : c.url;
      info.append(url);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn";
      del.textContent = "Удалить";
      del.onclick = () => { removeCustom(c.id); rebuildChannels(); };
      li.append(info, del);
      return li;
    }),
  );
}
window.addEventListener("velvet:channels", () => {
  drawCustom();
  if (shell.dataset.view === "home") renderHome(play);
});
drawCustom();

const dlg = document.getElementById("addDlg") as HTMLDialogElement;
const addName = document.getElementById("addName") as HTMLInputElement;
const addUrl = document.getElementById("addUrl") as HTMLInputElement;
const addAdult = document.getElementById("addAdult") as HTMLInputElement;
const addErr = document.getElementById("addErr")!;
document.getElementById("btnAddChannel")!.onclick = () => {
  addName.value = addUrl.value = "";
  addAdult.checked = false;
  addErr.textContent = "";
  dlg.showModal();
  addName.focus();
};
document.getElementById("addCancel")!.onclick = () => dlg.close();
document.getElementById("addForm")!.addEventListener("submit", (e) => {
  e.preventDefault();
  const error = addCustom(addName.value, addUrl.value, addAdult.checked);
  if (error) { addErr.textContent = error; return; }
  dlg.close();
  rebuildChannels();
});

/* перетаскивание каналов на главном экране; порядок запоминается */
enableSort(document.getElementById("grid")!, ".tile", (ids) => { saveOrder(ids); rebuildChannels(); });
document.getElementById("btnResetOrder")!.onclick = () => { resetOrder(); rebuildChannels(); };
