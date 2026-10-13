/* Перетаскивание карточек мышью: карточка-призрак едет за курсором, остальные плавно расступаются, порядок запоминается снаружи.
   Работает на событиях указателя, поэтому одинаково и в браузере, и в окне приложения. У карточки должен быть data-id и data-sort="1". */

let sorting = false;
export const isSorting = () => sorting;

/* плавное «расступание»: запоминаем положения до перестановки и анимируем смещение после */
function flip(items: HTMLElement[], change: () => void) {
  const before = new Map(items.map((el) => [el, el.getBoundingClientRect()]));
  change();
  for (const el of items) {
    const a = before.get(el)!;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (!dx && !dy) continue;
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    void el.offsetWidth;
    el.style.transition = "transform .22s cubic-bezier(0.22, 0.7, 0.2, 1)";
    el.style.transform = "";
  }
}

export function enableSort(container: HTMLElement, itemSel: string, onSorted: (ids: string[]) => void) {
  const THRESHOLD = 7;
  let pending: HTMLElement | null = null;
  let drag: HTMLElement | null = null;
  let ghost: HTMLElement | null = null;
  let startX = 0, startY = 0, grabX = 0, grabY = 0, lastX = 0, lastY = 0;
  let scroller: HTMLElement | null = null;
  let scrollTimer = 0;

  const items = () => [...container.querySelectorAll<HTMLElement>(itemSel)];

  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || drag) return;
    const target = e.target as HTMLElement;
    if (target.closest(".star, .heart")) return; // у кнопок-сердечек свои клики
    const it = target.closest<HTMLElement>(itemSel);
    if (!it || !container.contains(it) || it.dataset.sort !== "1") return;
    pending = it;
    startX = lastX = e.clientX;
    startY = lastY = e.clientY;
  });

  function begin(it: HTMLElement) {
    drag = it;
    sorting = true;
    const r = it.getBoundingClientRect();
    grabX = startX - r.left;
    grabY = startY - r.top;
    ghost = it.cloneNode(true) as HTMLElement;
    ghost.classList.add("drag-ghost");
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    document.body.append(ghost);
    it.classList.add("dragging");
    document.body.classList.add("sorting");
    scroller = container.closest<HTMLElement>(".view");
    scrollTimer = window.setInterval(autoScroll, 16);
  }

  function autoScroll() {
    if (!scroller || !drag) return;
    const r = scroller.getBoundingClientRect();
    const edge = 70;
    if (lastY < r.top + edge) scroller.scrollTop -= Math.ceil((r.top + edge - lastY) / 5);
    else if (lastY > r.bottom - edge) scroller.scrollTop += Math.ceil((lastY - (r.bottom - edge)) / 5);
    reorder();
  }

  function reorder() {
    if (!drag) return;
    if (ghost) ghost.style.display = "none";
    const hit = document.elementFromPoint(lastX, lastY)?.closest<HTMLElement>(itemSel);
    if (ghost) ghost.style.display = "";
    if (!hit || hit === drag || !container.contains(hit)) return;
    const list = items();
    const from = list.indexOf(drag), to = list.indexOf(hit);
    if (from < 0 || to < 0) return;
    flip(list, () => { if (from < to) hit.after(drag!); else hit.before(drag!); });
  }

  window.addEventListener("pointermove", (e) => {
    if (!pending && !drag) return;
    lastX = e.clientX;
    lastY = e.clientY;
    if (pending && !drag) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
      begin(pending);
    }
    if (!drag || !ghost) return;
    e.preventDefault();
    ghost.style.left = `${e.clientX - grabX}px`;
    ghost.style.top = `${e.clientY - grabY}px`;
    reorder();
  });

  function finish(commit: boolean) {
    clearInterval(scrollTimer);
    pending = null;
    if (!drag) return;
    drag.classList.remove("dragging");
    ghost?.remove();
    ghost = null;
    document.body.classList.remove("sorting");
    const ids = items().map((el) => el.dataset.id ?? "").filter(Boolean);
    drag = null;
    // сразу после отпускания браузер может послать «клик» — на долю секунды его не пускаем, чтобы канал не запустился
    const stop = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener("click", stop, { capture: true, once: true });
    window.setTimeout(() => { window.removeEventListener("click", stop, true); sorting = false; }, 60);
    if (commit) onSorted(ids);
  }

  window.addEventListener("pointerup", () => finish(true));
  window.addEventListener("pointercancel", () => finish(true));
  container.addEventListener("dragstart", (e) => e.preventDefault()); // встроенное перетаскивание картинок и ссылок не нужно
}
