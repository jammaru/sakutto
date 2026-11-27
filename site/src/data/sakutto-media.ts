/**
 * Responsive hero-wall media shared by the LCP <picture> and its preload hint.
 * Keeping the two in sync matters: a mismatched preload costs more than it saves.
 */

/** Exactly the rendered width of the .container-wide demo wall:
 *  - <= 456px: clamp(2rem, 7vw, 7rem) resolves to 2rem gutters -> 100vw - 2rem
 *  - 457..1238px: 7vw gutters -> 93vw (still below the 72rem cap)
 *  - >= 1239px: 93vw exceeds 72rem -> the wall box is a fixed 1152px
 * Keeping this in sync with both the <source> sizes and the preload
 * imagesizes is what stops a 1440w candidate from being fetched on desktop. */
export const HERO_SIZES =
  "(min-width: 1239px) 1152px, (min-width: 457px) 93vw, calc(100vw - 2rem)";

/** The 1152w candidate matches the desktop wall box exactly at 1x, so the
 *  browser never upscales a 1024w file or downloads an oversized 1280w one.
 *  1440w remains for high-density displays. */
const heroWidths = [768, 1024, 1152, 1280, 1440] as const;

function heroSrcset(format: "avif" | "webp"): string {
  return heroWidths.map((width) => `/reader/tea-garden-${width}.${format} ${width}w`).join(", ");
}

export const HERO_AVIF_SRCSET = heroSrcset("avif");
export const HERO_WEBP_SRCSET = heroSrcset("webp");
export const HERO_FALLBACK_SRC = "/reader/tea-garden-1280.webp";

/** Intrinsic size of the source photo (1440x960); CSS covers the wall box. */
export const HERO_INTRINSIC_WIDTH = 1440;
export const HERO_INTRINSIC_HEIGHT = 960;
