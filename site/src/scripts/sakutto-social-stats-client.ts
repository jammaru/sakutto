/** Refresh the GitHub star count without blocking first paint. */
import { formatSocialStat } from "../lib/social-stat-format";

export async function initSakuttoSocialStats(): Promise<void> {
  const targets = document.querySelectorAll<HTMLElement>('[data-social-stat-value="github"]');
  if (targets.length === 0) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("https://api.github.com/repos/jammaru/sakutto", {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) return;
    const data: unknown = await response.json();
    const stars = (data as { stargazers_count?: unknown }).stargazers_count;
    if (typeof stars !== "number" || !Number.isFinite(stars) || stars <= 0) return;
    for (const target of targets) target.textContent = formatSocialStat(stars);
  } catch {
    // Keep the build-time value when the network or rate limit gets in the way.
  } finally {
    clearTimeout(timer);
  }
}