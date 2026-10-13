// Сводка по журналу радио: какие станции и серверы чаще всего рвутся.
// Запуск: node tools/radio-log-summary.mjs                 — за последние 24 часа, журнал приложения по умолчанию
//         node tools/radio-log-summary.mjs --hours=72       — за 3 суток
//         node tools/radio-log-summary.mjs путь/к/radio.log — чужой журнал (например, присланный другом)
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const hours = Number((process.argv.find((a) => a.startsWith("--hours=")) ?? "").slice(8)) || 24;
const given = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dir = path.join(process.env.LOCALAPPDATA ?? "", "com.septeamone.velvetradio", "logs");
const files = given ? [given] : [path.join(dir, "radio.old.log"), path.join(dir, "radio.log")];
const since = Date.now() - hours * 3600 * 1000;

const lines = files.filter(existsSync).flatMap((f) => readFileSync(f, "utf8").split(/\r?\n/));
if (!lines.length) { console.log("Журнал не найден или пуст:", files.join(", ")); process.exit(0); }

const st = new Map(); // станция → счётчики
const hosts = new Map(); // сервер станции → обрывы на стороне прокси
const get = (m, k, init) => { if (!m.has(k)) m.set(k, init()); return m.get(k); };
const station = (id) => get(st, id, () => ({ starts: 0, startMs: 0, failed: 0, reconnects: {}, heals: 0 }));
const host = (h) => get(hosts, h, () => ({ drops: 0, restored: 0, gaveUp: 0, noOpen: 0 }));
let used = 0, offline = 0;

for (const line of lines) {
  const m = /^(\S+Z) (.*)$/.exec(line);
  if (!m || Date.parse(m[1]) < since) continue;
  used++;
  const t = m[2];
  let r;
  if ((r = /^радио (\S+) \d+k \S+: играет \(старт (\d+) мс/.exec(t))) { const s = station(r[1]); s.starts++; s.startMs += +r[2]; }
  else if ((r = /^радио (\S+) \d+k \S+: не вышло/.exec(t))) station(r[1]).failed++;
  else if ((r = /^радио (\S+): HLS .*лечу на месте/.exec(t))) station(r[1]).heals++;
  else if ((r = /^радио (\S+): (.+?), переподключаюсь/.exec(t))) { const s = station(r[1]); s.reconnects[r[2]] = (s.reconnects[r[2]] ?? 0) + 1; }
  else if (/интернет пропал/.test(t)) offline++;
  else if ((r = /^поток (\S+): .*переподключаю \(обрыв/.exec(t))) host(r[1]).drops++;
  else if ((r = /^поток (\S+): переподключён/.exec(t))) host(r[1]).restored++;
  else if ((r = /^поток (\S+): не вернулся/.exec(t))) host(r[1]).gaveUp++;
  else if ((r = /^поток (\S+): не открылся/.exec(t))) host(r[1]).noOpen++;
}

console.log(`Журнал за ${hours} ч: ${used} записей, пропаданий интернета: ${offline}\n`);
const score = (s) => s.failed + s.heals + Object.values(s.reconnects).reduce((a, b) => a + b, 0);
const rows = [...st].sort((a, b) => score(b[1]) - score(a[1]));
console.log("Станции (больше проблем — выше):");
for (const [id, s] of rows.slice(0, 15)) {
  const rec = Object.entries(s.reconnects).map(([why, n]) => `${why} ×${n}`).join("; ") || "—";
  console.log(`  ${id.padEnd(22)} запусков ${s.starts}, средний старт ${s.starts ? Math.round(s.startMs / s.starts) : 0} мс, неудачных адресов ${s.failed}, переподключений: ${rec}${s.heals ? `, лечений HLS ${s.heals}` : ""}`);
}
const hrows = [...hosts].sort((a, b) => b[1].drops - a[1].drops);
if (hrows.length) {
  console.log("\nСерверы станций (обрывы, которые прокси чинил сам):");
  for (const [h, x] of hrows.slice(0, 10)) console.log(`  ${h.padEnd(40)} обрывов ${x.drops}, вернулись ${x.restored}, сдались ${x.gaveUp}, не открылись ${x.noOpen}`);
}
