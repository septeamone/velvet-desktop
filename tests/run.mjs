// Автотесты интерфейса и радиодвижка: pnpm test
// Всё тихо и без окон: браузер скрытый, звук выключен (--mute-audio, громкость 0), «станция» — локальный сервер на порту 5301.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = 5199;
const BASE = `http://localhost:${PORT}/`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? `\n      ${detail}` : ""}`); };

/* найти скрытый Chromium, который уже скачан Playwright (если нет — подсказать, как поставить) */
function findChrome() {
  const root = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const shells = readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
  for (const d of shells) {
    const sub = readdirSync(path.join(root, d)).find((x) => x.startsWith("chrome-headless-shell"));
    const exe = sub && path.join(root, d, sub, "chrome-headless-shell.exe");
    if (exe && existsSync(exe)) return exe;
  }
  return undefined;
}

await import("./fake-radio.mjs"); // тестовая станция на 5301
const vite = spawn(`npx vite --port ${PORT} --strictPort`, { stdio: "ignore", shell: true });
// останавливаем всё дерево процессов сборщика (под Windows у npx есть дочерние процессы), потом выходим
const stopAll = (code) => {
  const done = () => process.exit(code);
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(vite.pid), "/T", "/F"], { stdio: "ignore" }).on("exit", done);
  else { vite.kill(); done(); }
};
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch { /* ещё стартует */ } await new Promise((r) => setTimeout(r, 500)); }

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: findChrome(), args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
} catch (e) {
  console.error("Не найден скрытый браузер для тестов. Поставьте один раз: npx playwright install chromium-headless-shell\n", String(e).slice(0, 200));
  stopAll(2);
}

const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
await ctx.addInitScript(() => { localStorage.setItem("velvet.rvol", "0"); window.__audios = []; const O = window.Audio; window.Audio = function (...a) { const e = new O(...a); e.muted = true; window.__audios.push(e); return e; }; });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
const open = async () => { await page.goto(BASE); await page.waitForTimeout(500); };

/* ---------- интерфейс ---------- */
console.log("Интерфейс");
await open();
const views = ["home", "radio", "settings"];
let overflow = [];
for (const [w, h] of [[760, 520], [860, 700], [1100, 800], [1101, 800], [1280, 800], [1920, 1080]]) {
  await page.setViewportSize({ width: w, height: h });
  for (const v of views) {
    await page.evaluate((v) => {
      if (v === "home") document.querySelector('#tabs button[data-tab="tv"]').click();
      if (v === "radio") document.querySelector('#tabs button[data-tab="radio"]').click();
      if (v === "settings" && document.getElementById("shell").dataset.view !== "settings") document.getElementById("btnSettings").click();
    }, v);
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
    if (r.sw > r.vw + 1) overflow.push(`${w}x${h} ${v}`);
  }
}
check("на всех размерах окна страницы не вылезают за край", overflow.length === 0, overflow.join(", "));
await page.setViewportSize({ width: 1300, height: 900 });
await page.evaluate(() => document.getElementById("btnSettings").click());
check("настройки разделены на «Общие», «ТВ» и «Радио»", await page.evaluate(() => [...document.querySelectorAll(".set-col h2")].map((h) => h.textContent).join("|") === "Общие|ТВ|Радио"));

/* «Что нового»: только то, что новее версии человека */
const news = await page.evaluate(async () => {
  const n = await import("/src/news.ts");
  const count = (since, until, notes) => { n.showChanges(since, until, notes); const c = document.querySelectorAll("#newsBody section").length; document.getElementById("newsDlg").close(); return c; };
  return { fromOld: count("1.0.0", "1.0.5"), oneBehind: count("1.0.4", "1.0.5"), none: n.hasNews("1.0.5", "1.0.5") };
});
check("«Что нового»: у отставшего на несколько версий — блоки по версиям", news.fromOld >= 3, JSON.stringify(news));
check("«Что нового»: у отставшего на одну версию — только она", news.oneBehind === 1, JSON.stringify(news));
check("«Что нового»: если нового нет, ничего не показываем", news.none === false);

/* ---------- радио ---------- */
console.log("Радио");
await open();
const radio = await page.evaluate(async () => {
  const m = await import("/src/radio-engine.ts");
  const st = await import("/src/settings.ts");
  m.setVolume(0);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 10000) => { const t = performance.now(); while (!f() && performance.now() - t < ms) await wait(100); }; // машина может быть занята: ждём результат, а не фиксированное время
  const mk = (id, urls) => ({ id, name: id, cc: "RU", g: "x", gn: "x", mark: "T", hue: 1, q: [{ k: 128, u: urls ?? [`http://127.0.0.1:5301/live?x=${id}`] }] });
  const live = () => window.__audios.filter((e) => !e.paused && e.currentSrc && e.readyState >= 2).length;
  const out = {};
  st.setSetting("rsmooth", "on");
  const ids = ["a", "b", "c", "d"];
  for (let i = 0; i < 12; i++) { m.play(mk(ids[i % 4])); await wait(80); }
  await until(() => m.state.status === "playing");
  out.rapid = { ok: m.state.status === "playing" && m.state.station.id === "d" && live() === 1, d: `${m.state.status} ${m.state.station?.id} играет:${live()}` };
  m.play(mk("p1")); await wait(100); m.toggle(); await wait(2500);
  out.pauseWhileConnecting = { ok: m.state.paused === true && live() === 0, d: `paused=${m.state.paused} играет:${live()}` };
  m.toggle(); await until(() => m.state.status === "playing" && !m.state.paused); // снова «играть»: подключается к эфиру
  out.resumeAfterPause = { ok: m.state.status === "playing" && !m.state.paused && live() === 1, d: `${m.state.status} paused=${m.state.paused} играет:${live()}` };
  m.stop(); await wait(300);
  m.play(mk("s1")); await wait(120); m.stop(); await wait(3500);
  out.stopWhileConnecting = { ok: m.state.status === "idle" && live() === 0, d: `${m.state.status} играет:${live()}` };
  const q2 = { id: "q", name: "q", cc: "RU", g: "x", gn: "x", mark: "Q", hue: 1, q: [{ k: 112, u: ["http://127.0.0.1:5301/live?x=q112"] }, { k: 320, u: ["http://127.0.0.1:5301/live?x=q320"] }] };
  m.play(q2); await wait(2500);
  for (let i = 0; i < 8; i++) { m.setQuality(i % 2 ? 320 : 112); await wait(60); }
  await until(() => m.state.status === "playing");
  out.qualityMash = { ok: m.state.status === "playing" && m.state.kbps === 320 && live() === 1, d: `${m.state.status} ${m.state.kbps} играет:${live()}` };
  m.setQuality(112);
  const instant = { kbps: m.state.kbps, status: m.state.status };
  await wait(80);
  out.qualityCutsOldAtOnce = { ok: instant.kbps === 112 && instant.status === "connecting" && window.__audios.filter((e) => !e.paused && /q320/.test(e.currentSrc)).length === 0, d: JSON.stringify(instant) };
  m.stop(); await wait(200);
  const t0 = performance.now();
  m.play(mk("dead", ["http://127.0.0.1:5302/a", "http://127.0.0.1:5302/b"]));
  while (m.state.status === "connecting" && performance.now() - t0 < 40000) await wait(250);
  out.allDead = { ok: m.state.status === "error", d: m.state.status };
  m.stop();
  m.play(mk("again")); await until(() => m.state.status === "playing");
  out.restartAfterError = { ok: m.state.status === "playing" && live() === 1, d: `${m.state.status} играет:${live()}` };
  m.stop();
  out.threeElements = { ok: window.__audios.length === 3, d: String(window.__audios.length) };
  return out;
});
const names = {
  rapid: "быстрое переключение станций: играет последняя и только одна",
  pauseWhileConnecting: "пауза во время подключения: звук не включается сам",
  resumeAfterPause: "после такой паузы «играть» снова подключает эфир",
  stopWhileConnecting: "стоп во время подключения: ничего не включается позже",
  qualityMash: "частая смена качества: итог верный, играет один поток",
  qualityCutsOldAtOnce: "смена качества сразу глушит прежний поток",
  allDead: "все адреса мертвы: ошибка, а не вечное «подключаюсь»",
  restartAfterError: "после ошибки станция запускается снова",
  threeElements: "аудио-элементы не плодятся (всегда три)",
};
for (const [k, v] of Object.entries(radio)) check(names[k], v.ok, v.d);

/* ---------- список станций ---------- */
console.log("Список станций");
await open();
await page.evaluate(() => document.querySelector('#tabs button[data-tab="radio"]').click());
await page.waitForTimeout(500);
await page.evaluate(() => document.getElementById("fCountry").click());
await page.waitForTimeout(150);
await page.evaluate(() => [...document.querySelectorAll("#pCountry .opt")].find((b) => /Все страны/.test(b.textContent)).click());
await page.waitForTimeout(600);
const grid = await page.evaluate(async () => {
  const m = await import("/src/radio-engine.ts");
  const g = document.getElementById("rGrid");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  let rebuilds = 0;
  new MutationObserver((l) => { for (const r of l) if (r.addedNodes.length > 50) rebuilds++; }).observe(g, { childList: true });
  for (let i = 0; i < 30; i++) { m.setVolume(i % 2 ? 0.1 : 0); await wait(30); }
  await wait(200);
  const btn = g.querySelectorAll(".s-main")[5]; btn.focus();
  m.setVolume(0.07); await frames2(); await wait(50);
  const lazy = [...g.querySelectorAll("img")].every((i) => i.loading === "lazy");
  return { cards: g.querySelectorAll(".scard").length, rebuilds, focusKept: document.activeElement === btn, lazy };
});
check("список: больше 400 станций", grid.cards > 400, String(grid.cards));
check("список не перестраивается при движении громкости", grid.rebuilds === 0, `перестроек: ${grid.rebuilds}`);
check("список: клавиатурный фокус не сбрасывается", grid.focusKept);
check("список: логотипы грузятся по мере прокрутки", grid.lazy);

/* ---------- журнал радио ---------- */
console.log("Журнал радио");
const ctx2 = await browser.newContext({ viewport: { width: 1300, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
await ctx2.addInitScript(() => {
  window.__TAURI__ = {
    core: { invoke: async (cmd) => (cmd === "proxy_info" ? { port: 1, token: "x" } : cmd === "extra_channels" ? JSON.stringify([{ id: "x-test", name: "Мой тестовый канал", logo: "", sources: ["https://example.com/a.m3u8"], epg: null }, { id: "bad", name: "Сломанный", sources: [] }]) : cmd === "radio_log" ? "2026-01-01T00:00:00Z радио тестовая строка журнала" : cmd === "is_portable" ? false : null) },
    window: { getCurrentWindow: () => ({ setTheme: async () => {} }) },
    app: { getVersion: async () => "9.9.9" }, updater: { check: async () => null }, process: { relaunch: async () => {} },
  };
});
const page2 = await ctx2.newPage();
await page2.goto(BASE);
await page2.waitForTimeout(800);
await page2.evaluate(() => document.getElementById("btnSettings").click());
await page2.click("#btnCopyLog");
await page2.waitForTimeout(400);
const copied = await page2.evaluate(() => navigator.clipboard.readText());
check("кнопка «Скопировать журнал» кладёт в буфер версию и журнал", copied.includes("Velvet TV 9.9.9") && copied.includes("тестовая строка журнала"), copied.slice(0, 120));
await page2.evaluate(() => document.querySelector('#tabs button[data-tab="tv"]').click());
await page2.waitForTimeout(300);
const extra = await page2.evaluate(async () => { const d = await import("/src/data.ts"); return { has: d.channels.some((c) => c.id === "x-test"), bad: d.channels.some((c) => c.id === "bad"), shown: document.getElementById("grid").textContent.includes("Мой тестовый канал") }; });
check("каналы из локального файла extra-channels.json появляются в списке (и переживают обновление)", extra.has && extra.shown, JSON.stringify(extra));
check("битая запись в этом файле игнорируется", !extra.bad);
check("после копирования показано подтверждение", (await page2.textContent("#logStatus")).includes("скопирован"));

check("в консоли нет ошибок страницы", pageErrors.length === 0, pageErrors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? `ПРОВАЛЕНО: ${failed} из ${results.length}` : `Всё в порядке: ${results.length} проверок`}`);
stopAll(failed ? 1 : 0);
