/* Избранные каналы: хранятся в памяти приложения, при изменении сообщают всем экранам. */
const KEY = "velvet.fav";
let ids = new Set<string>();
try { ids = new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]); } catch { /* пока пусто */ }

export const isFav = (id: string) => ids.has(id);
export const favCount = () => ids.size;

export function toggleFav(id: string) {
  if (!ids.delete(id)) ids.add(id);
  try { localStorage.setItem(KEY, JSON.stringify([...ids])); } catch { /* не страшно */ }
  window.dispatchEvent(new Event("velvet:fav"));
}
