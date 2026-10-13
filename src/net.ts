/* Доступ к сети: в приложении всё идёт через встроенный прокси, в обычном браузере напрямую. */
import { tauri } from "./tauri";

let base: string | null = null;

export async function initNet(): Promise<void> {
  const t = tauri();
  if (!t) return;
  const info = await t.core.invoke<{ port: number; token: string }>("proxy_info");
  base = `http://127.0.0.1:${info.port}/${info.token}/`;
}

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const viaProxy = (url: string) => (base ? base + b64url(url) : url);

/* прямой эфир Icecast/Shoutcast: прокси сам переподключается к станции, если она оборвала поток */
export const viaLive = (url: string) => (base ? `${base}live/${b64url(url)}` : url);
