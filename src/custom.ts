/* Свои каналы: добавляет сам человек по ссылке на поток. Хранятся только на этом компьютере. */
export type Custom = { id: string; name: string; url: string; adult: boolean };

const KEY = "velvet.custom";

export function loadCustom(): Custom[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((c): c is Custom => !!c && typeof c.id === "string" && typeof c.name === "string" && typeof c.url === "string");
  } catch {
    return [];
  }
}

function save(list: Custom[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* не страшно */ }
}

/* возвращает текст ошибки или null, если канал добавлен */
export function addCustom(name: string, url: string, adult: boolean): string | null {
  const n = name.trim();
  if (!n) return "Введите название канала.";
  if (n.length > 40) return "Название слишком длинное.";
  let u: URL;
  try { u = new URL(url.trim()); } catch { return "Ссылка выглядит неправильно."; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Нужна ссылка, которая начинается с http или https.";
  const list = loadCustom();
  list.push({ id: `my-${Date.now().toString(36)}`, name: n, url: u.href, adult });
  save(list);
  return null;
}

export function removeCustom(id: string) {
  save(loadCustom().filter((c) => c.id !== id));
}
