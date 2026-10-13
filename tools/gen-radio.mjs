// Берёт каталог радиостанций из снимка расширения Velvet Radio (_radio-source) и собирает данные для приложения.
// Запуск: node tools/gen-radio.mjs   — после того как в расширении добавили или изменили станции.
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ext = path.resolve("_radio-source"); // снимок расширения Velvet Radio (версия 1.5.0)
const { STATIONS, LOGOS, GENRES, COUNTRIES } = await import(pathToFileURL(path.join(ext, "stations.js")).href);

const stations = STATIONS.map((s) => {
  const g = typeof s.genre === "string" ? { key: s.genre, ru: GENRES[s.genre]?.[0] ?? s.genre } : { key: `x-${s.genre.ru}`, ru: s.genre.ru };
  return {
    id: s.id, name: s.name, ...(s.alt ? { alt: s.alt } : {}), cc: s.country, g: g.key, gn: g.ru, mark: s.mark, hue: s.hue,
    ...(LOGOS.has(s.id) ? { logo: 1 } : {}),
    q: s.qualities.map((x) => ({ k: x.kbps, u: x.urls, ...(x.hide ? { h: 1 } : {}), ...(x.hls ? { hls: 1 } : {}), ...(x.note ? { n: x.note } : {}) })),
  };
});
// итоги проверки адресов (tools/check-radio.mjs): упавшие дважды подряд убираем, упавшие один раз — в конец списка
if (existsSync("tools/radio-health.json")) {
  const fails = JSON.parse(readFileSync("tools/radio-health.json", "utf8")).urls;
  const n = (a) => fails[typeof a === "string" ? a : a.url]?.fails ?? 0; // адрес — строка или {url, hls}
  let removed = 0, demoted = 0, droppedQ = 0;
  for (const s of stations) {
    for (const q of s.q) {
      // Адреса сами не удаляем: проверка идёт из одной точки мира, а у слушателей (в России и не только) путь до станций другой.
      // Упавший адрес лишь уходит в конец списка; удалять — только осознанно: RADIO_PRUNE=1 node tools/gen-radio.mjs
      const alive = process.env.RADIO_PRUNE === "1" ? q.u.filter((u) => n(u) < 2) : q.u;
      if (alive.length && alive.length < q.u.length) removed += q.u.length - alive.length;
      const keep = alive.length ? alive : q.u; // если мёртвы все адреса качества, не трогаем
      const sorted = [...keep.filter((u) => n(u) === 0), ...keep.filter((u) => n(u) > 0)]; // порядок составителя сохраняется
      if (sorted.some((u, i) => u !== keep[i])) demoted++;
      q.u = sorted;
    }
    const live = s.q.filter((q) => q.u.some((u) => n(u) < 2));
    if (live.length && live.length < s.q.length) { droppedQ += s.q.length - live.length; s.q = live; } // качество без живых адресов убираем, если у станции есть другие
  }
  console.log(`по итогам проверки: убрано мёртвых адресов ${removed}, переставлено качеств ${demoted}, убрано качеств ${droppedQ}`);
}
// запасные адреса, найденные tools/find-mirrors.mjs (проверены, тот же владелец и тот же путь потока)
if (existsSync("tools/radio-mirrors.json")) {
  const mirrors = JSON.parse(readFileSync("tools/radio-mirrors.json", "utf8"));
  let added = 0;
  for (const s of stations) {
    for (const q of s.q) {
      const have = new Set(q.u.map((a) => (typeof a === "string" ? a : a.url)));
      for (const u of mirrors[s.id]?.[q.k] ?? []) if (!have.has(u)) { q.u.push(u); added++; }
    }
  }
  console.log(`запасных адресов добавлено: ${added}`);
}
const countries = [{ cc: "RU", aliases: ["россия", "russia", "рф"] }, ...COUNTRIES].filter((c, i, a) => a.findIndex((x) => x.cc === c.cc) === i);
writeFileSync("src/data/radio.json", JSON.stringify({ stations, countries }));

mkdirSync("public/radio", { recursive: true });
mkdirSync("public/flags", { recursive: true });
let logos = 0, flags = 0;
for (const s of stations) if (s.logo) { cpSync(path.join(ext, "logos", `${s.id}.png`), `public/radio/${s.id}.png`); logos++; }
for (const c of countries) {
  const f = path.join(ext, "flags", `${c.cc.toLowerCase()}.svg`);
  if (existsSync(f)) { cpSync(f, `public/flags/${c.cc.toLowerCase()}.svg`); flags++; }
}

// «что играет сейчас»: тот же код, но запросы идут через встроенный прокси
let np = readFileSync(path.join(ext, "nowplaying.js"), "utf8");
np = np.replace("await fetch(url, { cache: 'no-store' })", "await fetch(viaProxy(url), { cache: 'no-store', signal: AbortSignal.timeout(8000) })"); // зависший запрос не копится
np = np.replace("const r = await fetch(url, { headers: { 'Icy-MetaData': '1' }, signal: ctrl.signal });", "const r = await fetch(viaProxy(url), { headers: { 'Icy-MetaData': '1' }, signal: ctrl.signal });");
writeFileSync("src/nowplaying.ts", `// @ts-nocheck — копия nowplaying.js из расширения (генерируется tools/gen-radio.mjs, руками не править)\nimport { viaProxy } from "./net";\n${np}`);
console.log(`станций ${stations.length}, логотипов ${logos}, флагов ${flags}, стран ${countries.length}`);
execSync("python tools/to-webp.py", { stdio: "inherit" }); // логотипы в WebP: приложение легче
