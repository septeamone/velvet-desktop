// Проверка одного адреса станции: отвечает ли и идёт ли звук. Общая часть для check-radio.mjs и find-mirrors.mjs.
import net from "node:net";
import tls from "node:tls";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const TIMEOUT = 10000;

/* обычный поток: сырой запрос по сокету — так читаются и старые Shoutcast-станции с ответом «ICY 200 OK» */
export function probeStream(url0, redirects = 0) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let u;
    try { u = new URL(url0); } catch { return resolve({ ok: false, why: "плохой адрес" }); }
    const secure = u.protocol === "https:";
    const port = Number(u.port) || (secure ? 443 : 80);
    let buf = Buffer.alloc(0);
    let headEnd = -1, status = 0, ctype = "", loc = "", ttfb = 0, settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); sock.destroy(); resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, why: headEnd < 0 ? "нет ответа" : `мало данных (${buf.length - headEnd - 4} Б)` }), TIMEOUT);
    const sock = (secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port }));
    sock.setNoDelay(true);
    sock.on("error", (e) => finish({ ok: false, why: e.code || e.message }));
    sock.on("close", () => finish({ ok: false, why: headEnd < 0 ? "закрыто без ответа" : "закрыли рано" }));
    sock.on(secure ? "secureConnect" : "connect", () =>
      sock.write(`GET ${u.pathname || "/"}${u.search} HTTP/1.0\r\nHost: ${u.host}\r\nUser-Agent: ${UA}\r\nAccept: */*\r\nConnection: close\r\n\r\n`));
    sock.on("data", (d) => {
      if (!ttfb) ttfb = Date.now() - t0;
      buf = Buffer.concat([buf, d]);
      if (headEnd < 0) {
        headEnd = buf.indexOf("\r\n\r\n");
        if (headEnd < 0) return;
        const head = buf.subarray(0, headEnd).toString("latin1").split("\r\n");
        status = Number(/^(?:HTTP\/\d\.\d|ICY)\s+(\d+)/.exec(head[0])?.[1] ?? 0);
        for (const h of head.slice(1)) {
          const i = h.indexOf(":");
          if (i < 0) continue;
          const k = h.slice(0, i).trim().toLowerCase(), v = h.slice(i + 1).trim();
          if (k === "content-type") ctype = v.toLowerCase();
          if (k === "location") loc = v;
        }
        if ([301, 302, 303, 307, 308].includes(status) && loc) {
          if (redirects >= 5) return finish({ ok: false, why: "много перенаправлений" });
          settled = true; clearTimeout(timer); sock.destroy();
          return probeStream(new URL(loc, u).href, redirects + 1).then(resolve);
        }
        if (status < 200 || status >= 300) return finish({ ok: false, why: `HTTP ${status}` });
        if (ctype.includes("text/html") || ctype.includes("json")) return finish({ ok: false, why: `не звук (${ctype})` });
      }
      if (buf.length - headEnd - 4 >= 16384) finish({ ok: true, ms: ttfb });
    });
  });
}

async function get(url, ms, limit) {
  const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(ms), redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader();
  const chunks = [];
  let n = 0;
  while (n < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); n += value.length;
  }
  reader.cancel().catch(() => {});
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: n, url: r.url };
}

/* HLS: плейлист читается, а первый кусок реально скачивается */
export async function probeHls(url) {
  const t0 = Date.now();
  try {
    let { text, url: at } = await get(url, TIMEOUT, 262144);
    if (!text.includes("#EXTM3U")) return { ok: false, why: "не плейлист" };
    for (let depth = 0; depth < 3; depth++) {
      const next = text.split(/\r?\n/).find((l) => l && !l.startsWith("#"));
      if (!next) return { ok: false, why: "пустой плейлист" };
      const target = new URL(next, at).href;
      if (text.includes("#EXT-X-STREAM-INF")) { ({ text, url: at } = await get(target, TIMEOUT, 262144)); continue; } // главный плейлист → вложенный
      const seg = await get(target, TIMEOUT, 4096);
      return seg.bytes > 0 ? { ok: true, ms: Date.now() - t0 } : { ok: false, why: "кусок пустой" };
    }
    return { ok: false, why: "вложенность плейлиста" };
  } catch (e) {
    return { ok: false, why: e.cause?.code || e.message };
  }
}
