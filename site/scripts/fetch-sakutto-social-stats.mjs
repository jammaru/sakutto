import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "src", "data");
const fallbackPath = path.join(dataDir, "sakutto-social-stats.fallback.json");
const outputPath = path.join(dataDir, "sakutto-social-stats.json");

const SOURCES = {
  chromeUsers: "chrome-web-store",
  chromeRatingAverage: "chrome-web-store",
  chromeRatingCount: "chrome-web-store",
  githubStars: "github-api",
};

const endpoints = {
  github: "https://api.github.com/repos/jammaru/sakutto",
  chrome:
    "https://chromewebstore.google.com/detail/sakutto-local-ai-translat/mhlbjjijfkoghmcjndgdimhdlfkhadfl?hl=en",
};

const USER_AGENT = "sakutto-site-stats/1.0 (build-time stats fetch)";

// Lets us exercise the fallback path without editing endpoints:
// SAKUTTO_STATS_OFFLINE=1 pnpm build
const offline = process.env.SAKUTTO_STATS_OFFLINE === "1";

function warn(message) {
  console.warn(`[sakutto-stats] ${message}`);
}

async function get(url, accept, asJson = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return asJson ? await response.json() : await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function validCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validRatingAverage(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 5;
}

/** The listing renders the count as text, e.g. `<div>8,000 users</div>`. */
function parseChromeUsers(html) {
  if (typeof html !== "string") return undefined;
  const match =
    html.match(/([\d,]+)\s+users?\s*<\/div>/i) ?? html.match(/([\d,]+)\s+users?\b/i);
  if (!match) return undefined;
  const count = Number(match[1].replaceAll(",", ""));
  return validCount(count) ? count : undefined;
}

/** The listing header renders e.g. 'Average rating 4.7 out of 5 stars.' and '13 ratings'. */
function parseChromeRating(html) {
  if (typeof html !== "string") return undefined;
  const averageMatch =
    html.match(/aria-label="Average rating\s+([\d.]+)\s+out of 5 stars\."/i) ??
    html.match(/class="Vq0ZA">([\d.]+)<\/span>/i);
  if (!averageMatch) return undefined;

  const average = Math.round(Number(averageMatch[1]) * 10) / 10;
  if (!validRatingAverage(average)) return undefined;

  const countMatch =
    html.match(/class="xJEoWe">([\d,]+)\s+ratings?\s*<\/p>/i) ??
    html.match(/class="PmmSTd">([\d,]+)\s+ratings?\s*<\/span>/i);
  const count = countMatch ? Number(countMatch[1].replaceAll(",", "")) : undefined;

  return { average, count: validCount(count) ? count : undefined };
}

async function fetchWithFallback(key, label, fetchValue, source, fallback, isValid = validCount) {
  const useFallback = (reason) => {
    warn(`${label}: ${reason}; using fallback`);
    source[key] = "fallback";
    return fallback[key];
  };

  if (offline) return useFallback("offline mode");

  try {
    const value = await fetchValue();
    return isValid(value) ? value : useFallback(`unexpected value: ${String(value)}`);
  } catch (error) {
    return useFallback(error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  let fallback;
  try {
    fallback = JSON.parse(await fs.readFile(fallbackPath, "utf8"));
  } catch (error) {
    // The generated file is committed too, so a failed read must not fail the build.
    warn(`cannot read fallback file: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const stats = {
    chromeUsers: fallback.chromeUsers,
    chromeRatingAverage: fallback.chromeRatingAverage,
    chromeRatingCount: fallback.chromeRatingCount,
    githubStars: fallback.githubStars,
    fetchedAt: new Date().toISOString(),
    source: { ...SOURCES },
    verifiedAt: fallback.verifiedAt,
  };

  stats.githubStars = await fetchWithFallback(
    "githubStars",
    "GitHub API",
    async () => (await get(endpoints.github, "application/vnd.github+json", true))?.stargazers_count,
    stats.source,
    fallback,
  );

  // The listing page supplies both the user count and the rating in one request.
  let chromeHtml;
  if (offline) {
    warn("Chrome Web Store: offline mode");
  } else {
    try {
      chromeHtml = await get(endpoints.chrome, "text/html");
    } catch (error) {
      warn(`Chrome Web Store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const chromeRating = parseChromeRating(chromeHtml);
  stats.chromeUsers = await fetchWithFallback(
    "chromeUsers",
    "Chrome Web Store",
    () => parseChromeUsers(chromeHtml),
    stats.source,
    fallback,
  );
  stats.chromeRatingAverage = await fetchWithFallback(
    "chromeRatingAverage",
    "Chrome Web Store rating",
    () => chromeRating?.average,
    stats.source,
    fallback,
    validRatingAverage,
  );
  stats.chromeRatingCount = await fetchWithFallback(
    "chromeRatingCount",
    "Chrome Web Store rating count",
    () => chromeRating?.count,
    stats.source,
    fallback,
  );

  if (typeof stats.chromeRatingAverage !== "number") {
    // Nothing verified, even in the fallback: omit the stat instead of guessing.
    delete stats.chromeRatingAverage;
    delete stats.chromeRatingCount;
    delete stats.source.chromeRatingAverage;
    delete stats.source.chromeRatingCount;
  }

  await fs.writeFile(outputPath, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
  console.log(
    `[sakutto-stats] wrote ${path.relative(root, outputPath)} (${stats.chromeUsers} / ${stats.githubStars} / ${stats.chromeRatingAverage ?? "n/a"} star)`,
  );
}

try {
  await main();
} catch (error) {
  warn(`unexpected error; keeping existing stats file: ${error instanceof Error ? error.message : String(error)}`);
}
