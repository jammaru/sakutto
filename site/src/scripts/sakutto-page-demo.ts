/** Interactive upgrade for the hero translation demo (not needed for paint). */
export function initSakuttoPageDemo(): void {
  const demo = document.querySelector<HTMLElement>("[data-page-demo]");
  if (!demo) return;
  const popup = demo.querySelector<HTMLElement>(".popup")!;
  const icon = demo.querySelector<HTMLButtonElement>(".extension")!;
  const action = demo.querySelector<HTMLButtonElement>(".translate")!;
  const mode = demo.querySelector("select")!;
  const progress = demo.querySelector("progress")!;
  const segments = Array.from(demo.querySelectorAll<HTMLElement>("[data-segment]"));
  let count = 0;
  let active = false;
  let timer = 0;

  function render() {
    for (const [index, node] of segments.entries()) {
      const source = node.firstElementChild as HTMLElement;
      const translation = node.lastElementChild as HTMLElement;
      translation.hidden = index >= count;
      source.hidden = !translation.hidden && mode.value === "replace";
    }
    action.textContent = active ? demo!.dataset.restore! : demo!.dataset.start!;
    progress.value = count;
    progress.hidden = !active || count === segments.length;
  }

  function toggleTranslation() {
    clearInterval(timer);
    active = !active;
    count = 0;
    render();
    if (active) {
      timer = window.setInterval(() => {
        count++;
        render();
        if (count === segments.length) clearInterval(timer);
      }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 45 : 460);
    }
  }

  function closePopup() {
    popup.hidden = true;
    icon.setAttribute("aria-expanded", "false");
  }

  icon.addEventListener("click", () => {
    if (!popup.hidden) {
      closePopup();
      return;
    }
    popup.hidden = false;
    icon.setAttribute("aria-expanded", "true");
    action.focus({ preventScroll: true });
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !popup.contains(event.target) && !icon.contains(event.target)) {
      closePopup();
    }
  });
  demo.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popup.hidden) {
      closePopup();
      icon.focus();
    }
  });
  mode.addEventListener("change", render);
  action.addEventListener("click", toggleTranslation);
}