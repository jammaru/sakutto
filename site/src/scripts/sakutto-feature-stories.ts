/** Below-the-fold poster -> animated demo upgrade. */
export function initSakuttoFeatureStories(): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const image = entry.target as HTMLImageElement;
      const animated = image.dataset.animatedSrc;
      if (animated) {
        image.removeAttribute("srcset");
        image.removeAttribute("sizes");
        image.src = animated;
      }
      observer.unobserve(image);
    }
  }, { rootMargin: "200px" });

  for (const image of document.querySelectorAll<HTMLImageElement>("[data-animated-src]")) {
    observer.observe(image);
  }
}