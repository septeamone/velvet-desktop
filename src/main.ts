import "./styles.css";
import { initNet } from "./net";
import { channels } from "./data";
import { loadSettings, setSetting, settings, onSetting, type Settings } from "./settings";
import { renderHome } from "./home";
import { initUpdater } from "./updater";
import { startEpg } from "./epg";
import { openChannel, leave, hooks, pokeUi } from "./player";

type View = "home" | "radio" | "settings" | "player";
const shell = document.getElementById("shell")!;
let tab: "tv" | "radio" = "tv";

function show(view: View) {
  shell.dataset.view = view;
  document.querySelectorAll<HTMLElement>("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(view !== "settings" && b.dataset.tab === tab)));
  document.getElementById("btnSettings")!.setAttribute("aria-pressed", String(view === "settings"));
  if (view === "home") renderHome(play);
}

function play(i: number) {
  show("player");
  openChannel(i);
  pokeUi();
}

hooks.back = () => { leave(); show(tab === "tv" ? "home" : "radio"); };

document.querySelectorAll<HTMLElement>("#tabs button").forEach((b) => {
  b.onclick = () => { tab = b.dataset.tab as "tv" | "radio"; show(tab === "tv" ? "home" : "radio"); };
});
document.getElementById("btnSettings")!.onclick = () => show(shell.dataset.view === "settings" ? (tab === "tv" ? "home" : "radio") : "settings");

/* настройки: все переключатели собираются одинаково */
document.querySelectorAll<HTMLElement>(".seg[data-key]").forEach((seg) => {
  const key = seg.dataset.key as keyof Settings;
  const paint = () => seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === settings[key])));
  seg.querySelectorAll("button").forEach((b) => (b.onclick = () => setSetting(key, b.dataset.value as never)));
  onSetting((k) => { if (k === key) paint(); });
  paint();
});

setInterval(() => { if (shell.dataset.view === "home") renderHome(play); }, 30000);
window.addEventListener("velvet:epg", () => { if (shell.dataset.view === "home") renderHome(play); });

loadSettings();
document.querySelectorAll(".seg[data-key]").forEach((seg) => {
  const key = (seg as HTMLElement).dataset.key as keyof Settings;
  seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === settings[key])));
});

void initNet().then(() => {
  void initUpdater();
  startEpg();
  let last: string | null = null;
  try { last = localStorage.getItem("velvet.last"); } catch { /* ничего */ }
  const li = channels.findIndex((c) => c.id === last);
  if (settings.start === "last" && li >= 0) play(li);
  else show("home");
});
