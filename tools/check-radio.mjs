// Проверяет все адреса радиостанций: отвечает ли станция и идёт ли звук.
// Запуск: node tools/check-radio.mjs            — проверить всё и обновить tools/radio-health.json
//         node tools/check-radio.mjs --only=europaplus,record   — только эти станции (для проверки)
// Результат читает tools/gen-radio.mjs: адрес, упавший в двух проверках подряд, убирается (если у качества есть живые),
// а упавший один раз уходит в конец списка. Запускать лучше без VPN: так видно, что слышит человек в России.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { probeStream, probeHls } from "./probe.mjs";

const HEALTH = "tools/radio-health.json";
const CONCURRENCY = 24;
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);

// берём полный каталог из исходника (а не из готового radio.json, где мёртвые адреса уже убраны), чтобы ожившие вернулись
const { STATIONS } = await import(pathToFileURL(path.resolve("_radio-source/stations.js")).href);
// адрес — строка или {url, hls}: у части станций среди обычных потоков есть HLS
const stations = STATIONS.map((s) => ({ id: s.id, q: s.qualities.map((x) => ({ u: x.urls.map((a) => (typeof a === "string" ? a : a.url)), hls: x.urls.map((a) => !!x.hls || !!a.hls) })) }));
const jobs = new Map(); // адрес → HLS ли
for (const s of stations) {
  if (ONLY.length && !ONLY.includes(s.id)) continue;
  for (const q of s.q) q.u.forEach((u, i) => jobs.set(u, q.hls[i]));
}
// запасные адреса из tools/radio-mirrors.json проверяются так же
if (existsSync("tools/radio-mirrors.json")) {
  const mirrors = JSON.parse(readFileSync("tools/radio-mirrors.json", "utf8"));
  for (const [id, qs] of Object.entries(mirrors)) {
    if (ONLY.length && !ONLY.includes(id)) continue;
    for (const urls of Object.values(qs)) for (const u of urls) jobs.set(u, /\.m3u8(\?|$)/i.test(u));
  }
}

const health = existsSync(HEALTH) ? JSON.parse(readFileSync(HEALTH, "utf8")) : { urls: {} };
const list = [...jobs];
const results = new Map();
let i = 0, done = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (i < list.length) {
    const [url, hls] = list[i++];
    results.set(url, await (hls ? probeHls(url) : probeStream(url)));
    if (++done % 50 === 0) console.log(`  проверено ${done} из ${list.length}`);
  }
}));

const now = new Date().toISOString();
let dead = 0;
for (const [url, r] of results) {
  const prev = health.urls[url] ?? { fails: 0 };
  health.urls[url] = r.ok ? { fails: 0, ok: true, ms: r.ms, last: now } : { fails: Math.min(5, prev.fails + 1), ok: false, why: r.why, last: now };
  if (!r.ok) dead++;
}
for (const u of Object.keys(health.urls)) if (!jobs.has(u) && !ONLY.length) delete health.urls[u]; // адреса, которых в каталоге уже нет
health.updated = now;
writeFileSync(HEALTH, JSON.stringify(health, null, 1));

console.log(`\nпроверено адресов ${results.size}, живых ${results.size - dead}, не отвечают ${dead}`);
const lost = [];
for (const s of stations) {
  if (ONLY.length && !ONLY.includes(s.id)) continue;
  if (s.q.every((q) => q.u.every((u) => results.get(u)?.ok === false))) lost.push(s.id);
}
if (lost.length) console.log(`станции, у которых не отвечает ни один адрес (${lost.length}): ${lost.join(", ")}`);
const byWhy = {};
for (const [, r] of results) if (!r.ok) byWhy[r.why] = (byWhy[r.why] ?? 0) + 1;
console.log("причины:", byWhy);
