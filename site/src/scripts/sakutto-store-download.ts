import {
  DEFAULT_SAKUTTO_BROWSER,
  type SakuttoBrowserId,
  SAKUTTO_BROWSER_IDS,
} from "../data/sakutto-browser";

export function detectSakuttoBrowser(userAgent: string): SakuttoBrowserId {
  if (/Edg\//.test(userAgent)) return "edge";
  if (typeof navigator !== "undefined" && "brave" in navigator) return "brave";
  if (/OPR\//.test(userAgent) || /Opera/.test(userAgent)) return "opera";
  if (/Vivaldi/i.test(userAgent)) return "vivaldi";
  if (/\bArc\//.test(userAgent) || /Arc Browser/i.test(userAgent)) return "arc";
  if (/Firefox/i.test(userAgent)) return "firefox";
  return DEFAULT_SAKUTTO_BROWSER;
}

function setBrowserIcons(
  root: Element,
  prefix: string,
  activeId: SakuttoBrowserId,
  ids: readonly SakuttoBrowserId[] = SAKUTTO_BROWSER_IDS,
): void {
  for (const id of ids) {
    const icon = root.querySelector<SVGElement>(`.${prefix}-${id}`);
    if (!icon) continue;
    icon.classList.toggle("is-hidden", id !== activeId);
  }
}

export function initSakuttoStoreCtaPairs(root: ParentNode = document): void {
  const pairs = root.querySelectorAll<HTMLElement>("[data-store-cta-pair]");

  for (const block of pairs) {
    const primary = block.querySelector<HTMLAnchorElement>("[data-store-cta-primary]");
    const secondary = block.querySelector<HTMLAnchorElement>("[data-store-cta-secondary]");
    const primaryLabel = block.querySelector<HTMLElement>("[data-store-cta-primary-label]");
    const secondaryLabel = block.querySelector<HTMLElement>("[data-store-cta-secondary-label]");

    if (!primary || !secondary || !primaryLabel || !secondaryLabel) continue;

    const labels = JSON.parse(block.dataset.labels ?? "{}") as Record<SakuttoBrowserId, string>;
    const chromeUrl = block.dataset.chrome ?? "";
    const firefoxUrl = block.dataset.firefox ?? "";
    const browser = detectSakuttoBrowser(navigator.userAgent);

    if (browser === "firefox") {
      primary.href = firefoxUrl;
      primaryLabel.textContent = labels.firefox ?? sakuttoBrowserLabelFallback("firefox", labels);
      setBrowserIcons(block, "store-cta-icon", "firefox");

      secondary.href = chromeUrl;
      secondaryLabel.textContent = labels.chrome ?? sakuttoBrowserLabelFallback("chrome", labels);
      block.querySelector<SVGElement>(".store-cta-icon-secondary-firefox")?.classList.add("is-hidden");
      block.querySelector<SVGElement>(".store-cta-icon-secondary-chrome")?.classList.remove("is-hidden");
    } else {
      primary.href = chromeUrl;
      primaryLabel.textContent = labels[browser] ?? labels[DEFAULT_SAKUTTO_BROWSER];
      setBrowserIcons(block, "store-cta-icon", browser);

      secondary.href = firefoxUrl;
      secondaryLabel.textContent = labels.firefox ?? sakuttoBrowserLabelFallback("firefox", labels);
      block.querySelector<SVGElement>(".store-cta-icon-secondary-chrome")?.classList.add("is-hidden");
      block.querySelector<SVGElement>(".store-cta-icon-secondary-firefox")?.classList.remove("is-hidden");
    }
  }
}

function sakuttoBrowserLabelFallback(id: SakuttoBrowserId, labels: Record<SakuttoBrowserId, string>): string {
  return labels[id] ?? labels[DEFAULT_SAKUTTO_BROWSER];
}

export function initSakuttoStoreDownloadBlocks(root: ParentNode = document): void {
  const blocks = root.querySelectorAll<HTMLElement>("[data-store-download]");

  for (const block of blocks) {
    const primary = block.querySelector<HTMLAnchorElement>("[data-store-primary]");
    const label = block.querySelector<HTMLElement>("[data-store-label]");
    const chevron = block.querySelector<HTMLButtonElement>("[data-store-chevron]");
    const menu = block.querySelector<HTMLElement>(".store-download-menu");

    if (!primary || !label || !chevron || !menu) continue;

    const labels = JSON.parse(block.dataset.labels ?? "{}") as Record<SakuttoBrowserId, string>;
    const chromeUrl = block.dataset.chrome ?? "";
    const firefoxUrl = block.dataset.firefox ?? "";
    const browser = detectSakuttoBrowser(navigator.userAgent);
    const href = browser === "firefox" ? firefoxUrl : chromeUrl;

    primary.href = href;
    label.textContent = labels[browser] ?? labels[DEFAULT_SAKUTTO_BROWSER];

    for (const id of SAKUTTO_BROWSER_IDS) {
      const icon = block.querySelector<SVGElement>(`.store-download-icon-${id}`);
      if (!icon) continue;
      icon.classList.toggle("is-hidden", id !== browser);
    }

    if (block.dataset.storeBound === "1") continue;
    block.dataset.storeBound = "1";

    const close = () => {
      menu.hidden = true;
      chevron.setAttribute("aria-expanded", "false");
    };

    const open = () => {
      menu.hidden = false;
      chevron.setAttribute("aria-expanded", "true");
      menu.querySelector<HTMLAnchorElement>("[role=menuitem]")?.focus();
    };

    chevron.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menu.hidden) open();
      else close();
    });

    document.addEventListener("pointerdown", (event) => {
      if (menu.hidden) return;
      if (event.target instanceof Node && !block.contains(event.target)) close();
    });

    block.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) {
        close();
        chevron.focus();
      }
    });
  }
}