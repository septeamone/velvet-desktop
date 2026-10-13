import { tauri, type UpdateInfo } from "./tauri";
import { viaProxy } from "./net";
import { bindNews, hasNews, initNews, showChanges } from "./news";
import { newer } from "./version";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/* Установленная версия обновляется встроенным механизмом Tauri (установщик). Портативная заменяет сама себя новым файлом. */
const PORTABLE_JSON = "https://github.com/septeamone/velvet-desktop/releases/latest/download/latest-portable.json";
type PortableInfo = { version: string; url: string; signature: string; notes?: string };

let pending: UpdateInfo | null = null;
let pendingPortable: PortableInfo | null = null;
let portable = false;
let busy = false;

const chip = () => $("updateChip");
const banner = () => $("banner");

function setStatus(text: string) {
  $("updateStatus").textContent = text;
}

let installed = ""; // установленная версия
let found: { version: string; notes?: string } | null = null; // найденное обновление: для окна «Что нового»

function announce(version: string, notes?: string) {
  found = { version, notes };
  $("bannerNews").hidden = !hasNews(installed, version, notes);
  setStatus(`Доступна версия ${version}.`);
  chip().hidden = false;
  $("bannerText").textContent = `Доступна версия ${version}`;
  banner().classList.add("open");
}

export type CheckResult = "found" | "none" | "error" | "browser";

export async function checkForUpdate(): Promise<CheckResult> {
  const t = tauri();
  if (!t) { setStatus("Обновления работают в установленной программе."); return "browser"; }
  setStatus("Проверяю…");
  try {
    if (portable) {
      const r = await fetch(viaProxy(`${PORTABLE_JSON}?v=${Math.floor(Date.now() / 300000)}`), { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(String(r.status));
      const info = (await r.json()) as PortableInfo;
      if (!newer(info.version, await t.app.getVersion())) { setStatus("У вас последняя версия."); return "none"; }
      pendingPortable = info;
      announce(info.version, info.notes);
      return "found";
    }
    const u = await t.updater.check();
    if (!u) { setStatus("У вас последняя версия."); return "none"; }
    pending = u;
    announce(u.version, u.body);
    return "found";
  } catch {
    setStatus("Не удалось проверить обновления. Проверьте подключение к интернету.");
    return "error";
  }
}

async function install() {
  if (busy || (!pending && !pendingPortable)) return;
  busy = true;
  const t = tauri();
  const bar = $("bannerBar"), text = $("bannerText");
  banner().classList.add("open", "busy");

  if (pendingPortable) { // портативная версия: файл скачивается, проверяется и подменяется, потом программа сама перезапускается
    text.textContent = "Загружаю обновление…";
    bar.style.width = "100%";
    try {
      await t!.core.invoke("portable_update", { url: pendingPortable.url, signature: pendingPortable.signature, version: pendingPortable.version });
    } catch {
      busy = false;
      banner().classList.remove("busy");
      text.textContent = "Не удалось обновить. Переместите файл программы в обычную папку (не в Program Files) и повторите.";
    }
    return;
  }

  let total = 0, got = 0;
  try {
    await pending!.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data?.contentLength ?? 0;
      if (e.event === "Progress") {
        got += e.data?.chunkLength ?? 0;
        if (total) { bar.style.width = `${Math.round((got / total) * 100)}%`; text.textContent = `Загрузка ${Math.round((got / total) * 100)}%`; }
      }
      if (e.event === "Finished") text.textContent = "Устанавливаю…";
    });
    text.textContent = "Перезапускаю…";
    await t?.process.relaunch();
  } catch {
    busy = false;
    banner().classList.remove("busy");
    text.textContent = "Не удалось обновить. Попробуйте ещё раз позже.";
  }
}

export async function initUpdater() {
  const t = tauri();
  bindNews();
  if (t) {
    try { portable = await t.core.invoke<boolean>("is_portable"); } catch { portable = false; }
    try {
      const v = await t.app.getVersion();
      installed = v;
      $("version").textContent = `Velvet TV · версия ${v}${portable ? " · портативная" : ""}`;
      initNews(v);
    } catch { /* ничего */ }
  } else $("version").textContent = "Версия для разработки";
  $("btnCheck").onclick = () => void checkForUpdate();
  $("bannerInstall").onclick = () => void install();
  $("bannerNews").onclick = () => { if (found) showChanges(installed, found.version, found.notes); };
  $("bannerLater").onclick = () => banner().classList.remove("open");
  chip().onclick = () => banner().classList.add("open");
  // тихая проверка после запуска
  setTimeout(() => void checkForUpdate().then(() => { if (!pending && !pendingPortable) setStatus(""); }), 6000);
}
