// Тестовая «радиостанция»: бесконечный WAV в реальном времени. Параметры: ?drop=N — оборвать через N с, ?silent=N — после N с слать тишину.
import http from "node:http";

const RATE = 22050;
const stats = { conns: 0, byPath: {} };

function header() {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(0xffffffff, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(0xffffffff, 40);
  return h;
}

let phase = 0;
function block(seconds, silent) {
  const n = Math.round(RATE * seconds);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = silent ? 0 : Math.round(Math.sin(phase) * 9000);
    phase += (2 * Math.PI * 440) / RATE;
    b.writeInt16LE(v, i * 2);
  }
  return b;
}

export const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/stats") { res.setHeader("access-control-allow-origin", "*"); return res.end(JSON.stringify(stats)); }
  stats.conns++;
  stats.byPath[u.pathname + u.search] = (stats.byPath[u.pathname + u.search] ?? 0) + 1;
  if (u.pathname === "/hang") return; // принял и молчит
  const drop = Number(u.searchParams.get("drop") ?? 0);
  const silentAfter = Number(u.searchParams.get("silent") ?? 0);
  const t0 = Date.now();
  res.writeHead(200, { "content-type": "audio/wav", "access-control-allow-origin": "*", "cache-control": "no-store" });
  res.write(header());
  res.write(block(7, false)); // как накопленный прокси запас: 7 с сразу
  let sent = 7; // секунд отдано
  const timer = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    while (sent < el + 7) { // держим отрыв в 7 с, дальше — в реальном времени
      const silent = silentAfter && sent > silentAfter;
      res.write(block(0.1, silent));
      sent += 0.1;
    }
    if (drop && el > drop) { clearInterval(timer); res.destroy(); }
  }, 100);
  req.on("close", () => clearInterval(timer));
}); server.listen(5301);
