// Берёт каталог радиостанций из расширения Velvet Radio (только читает его) и собирает данные для приложения.
// Запуск: node tools/gen-radio.mjs   — после того как в расширении добавили или изменили станции.
import { pathToFileURL } from "node:url";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ext = path.resolve("..", "radio-extension");
const { STATIONS, LOGOS, GENRES, COUNTRIES } = await import(pathToFileURL(path.join(ext, "stations.js")).href);

const stations = STATIONS.map((s) => {
  const g = typeof s.genre === "string" ? { key: s.genre, ru: GENRES[s.genre]?.[0] ?? s.genre } : { key: `x-${s.genre.ru}`, ru: s.genre.ru };
  return {
    id: s.id, name: s.name, ...(s.alt ? { alt: s.alt } : {}), cc: s.country, g: g.key, gn: g.ru, mark: s.mark, hue: s.hue,
    ...(LOGOS.has(s.id) ? { logo: 1 } : {}),
    q: s.qualities.map((x) => ({ k: x.kbps, u: x.urls, ...(x.hide ? { h: 1 } : {}), ...(x.hls ? { hls: 1 } : {}), ...(x.note ? { n: x.note } : {}) })),
  };
});
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
np = np.replace("await fetch(url, { cache: 'no-store' })", "await fetch(viaProxy(url), { cache: 'no-store' })");
np = np.replace("const r = await fetch(url, { headers: { 'Icy-MetaData': '1' }, signal: ctrl.signal });", "const r = await fetch(viaProxy(url), { headers: { 'Icy-MetaData': '1' }, signal: ctrl.signal });");
writeFileSync("src/nowplaying.ts", `// @ts-nocheck — копия nowplaying.js из расширения (генерируется tools/gen-radio.mjs, руками не править)\nimport { viaProxy } from "./net";\n${np}`);
console.log(`станций ${stations.length}, логотипов ${logos}, флагов ${flags}, стран ${countries.length}`);
