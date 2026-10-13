/* Журнал радио: строки уходят в файл radio.log приложения (в обычном браузере — только в консоль). */
import { tauri } from "./tauri";

export function rlog(text: string) {
  console.debug("[радио]", text);
  void tauri()?.core.invoke("log_line", { text: `радио ${text}` }).catch(() => undefined);
}
