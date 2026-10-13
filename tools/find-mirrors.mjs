// Ищет запасные адреса для станций, у которых на каждое качество всего один адрес.
// Источник — открытая база radio-browser.info. Берём осторожно, чтобы не подмешать чужую станцию:
//   1) название станции совпадает целиком (без учёта регистра и знаков), страна та же;
//   2) адрес принадлежит тому же владельцу (тот же основной домен) и ведёт на тот же путь потока (то же имя файла), что у имеющегося адреса этого качества;
//   3) адрес сейчас отвечает и отдаёт звук.
// Запуск: node tools/find-mirrors.mjs [--only=id1,id2]   — результат в tools/radio-mirrors.json; gen-radio.mjs добавляет его в каталог.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { probeStream, probeHls } from "./probe.mjs";

const OUT = "tools/radio-mirrors.json";
const API = ["https://de1.api.radio-browser.info", "https://de2.api.radio-browser.info"];
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);

const { stations } = JSON.parse(readFileSync("src/data/radio.json", "utf8"));
const urlOf = (a) => (typeof a === "string" ? a : a.url);
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const SECOND = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
const domainOf = (u) => {
  try {
    const parts = new URL(u).hostname.split(".");
    const n = parts.length >= 3 && SECOND.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
    return parts.slice(-n).join(".");
  } catch { return ""; }
};

const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ""; } };

async function search(name, cc) {
  for (const base of API) {
    try {
      const r = await fetch(`${base}/json/stations/search?name=${encodeURIComponent(name)}&countrycode=${cc}&limit=40&hidebroken=true&order=votes&reverse=true`, { signal: AbortSignal.timeout(12000), headers: { "user-agent": "VelvetTV-mirror-finder/1.0" } });
      if (r.ok) return await r.json();
    } catch { /* пробуем следующий сервер */ }
  }
  return [];
}

const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const todo = stations.filter((s) => (!ONLY.length || ONLY.includes(s.id)) && s.q.some((q) => q.u.length < 2));
console.log(`станций с одним адресом хотя бы у одного качества: ${todo.length}`);
let found = 0;
for (const s of todo) {
  const hits = await search(s.name, s.cc);
  const same = hits.filter((h) => norm(h.name) === norm(s.name));
  for (const q of s.q) {
    if (q.u.length >= 2) continue;
    const have = new Set(q.u.map(urlOf));
    const owners = new Set([...have].map(domainOf));
    const paths = new Set([...have].map(pathOf)); // у настоящего зеркала путь потока тот же (иначе это может быть другое качество или канал)
    const cands = new Set();
    for (const h of same) for (const u of [h.url_resolved, h.url]) if (u && !u.includes("?") && !have.has(u) && owners.has(domainOf(u)) && paths.has(pathOf(u))) cands.add(u);
    for (const u of cands) {
      const r = await (/\.m3u8(\?|$)/i.test(u) ? probeHls(u) : probeStream(u));
      if (!r.ok) continue;
      ((existing[s.id] ??= {})[q.k] ??= []).includes(u) || existing[s.id][q.k].push(u);
      found++;
      console.log(`  + ${s.id} ${q.k}k: ${u}`);
      break; // одного запасного адреса на качество достаточно
    }
  }
  await new Promise((r) => setTimeout(r, 250)); // не нагружаем открытую базу
}
writeFileSync(OUT, JSON.stringify(existing, null, 1));
console.log(`найдено запасных адресов: ${found}; записано в ${OUT}`);
