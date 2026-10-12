import { tauri, type UpdateInfo } from "./tauri";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let pending: UpdateInfo | null = null;
let busy = false;

const chip = () => $("updateChip");
const banner = () => $("banner");

function setStatus(text: string) {
  $("updateStatus").textContent = text;
}

export type CheckResult = "found" | "none" | "error" | "browser";

export async function checkForUpdate(): Promise<CheckResult> {
  const t = tauri();
  if (!t) { setStatus("Обновления работают в установленной программе."); return "browser"; }
  setStatus("Проверяю…");
  try {
    const u = await t.updater.check();
    if (!u) { setStatus("У вас последняя версия."); return "none"; }
    pending = u;
    setStatus(`Доступна версия ${u.version}.`);
    chip().hidden = false;
    $("bannerText").textContent = `Доступна версия ${u.version}`;
    banner().classList.add("open");
    return "found";
  } catch {
    setStatus("Не удалось проверить обновления. Проверьте подключение к интернету.");
    return "error";
  }
}

async function install() {
  if (!pending || busy) return;
  busy = true;
  const t = tauri();
  const bar = $("bannerBar"), text = $("bannerText");
  banner().classList.add("open", "busy");
  let total = 0, got = 0;
  try {
    await pending.downloadAndInstall((e) => {
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
  try { $("version").textContent = t ? `Версия ${await t.app.getVersion()}` : "Версия для разработки"; } catch { /* ничего */ }
  $("btnCheck").onclick = () => void checkForUpdate();
  $("bannerInstall").onclick = () => void install();
  $("bannerLater").onclick = () => banner().classList.remove("open");
  chip().onclick = () => banner().classList.add("open");
  // тихая проверка после запуска
  setTimeout(() => void checkForUpdate().then(() => { if (!pending) setStatus(""); }), 6000);
}
