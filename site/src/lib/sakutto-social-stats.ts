import generated from "../data/sakutto-social-stats.json";
import fallback from "../data/sakutto-social-stats.fallback.json";

export { formatSocialStat } from "./social-stat-format";

export interface SakuttoSocialStats {
  chromeUsers: number;
  githubStars: number;
  /** Undefined when neither the live listing nor the fallback had a rating. */
  chromeRatingAverage?: number;
  chromeRatingCount?: number;
  fetchedAt: string;
  verifiedAt?: string;
  source: Record<string, string>;
}

function positive(value: number, fallbackValue: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallbackValue;
}

function verifiedAverage(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 5) return undefined;
  return Math.round(value * 10) / 10;
}

function verifiedCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** e.g. `4.7 ★ (13)`; the count is left out when it was not verified. */
export function formatChromeRating(
  average: number | undefined,
  count?: number | undefined,
): string | undefined {
  const rating = verifiedAverage(average);
  if (rating === undefined) return undefined;
  const value = `${rating} ★`;
  const verified = verifiedCount(count);
  return verified === undefined ? value : `${value} (${verified})`;
}

// Rating fields are deliberately absent when nothing could be verified.
const generatedStats = generated as Partial<SakuttoSocialStats>;
const fallbackStats = fallback as Partial<SakuttoSocialStats>;

/** Build-time numbers, with the checked-in fallback as a final safety net. */
export const sakuttoSocialStats: SakuttoSocialStats = {
  ...generatedStats,
  chromeUsers: positive(generatedStats.chromeUsers ?? 0, fallbackStats.chromeUsers ?? 0),
  githubStars: positive(generatedStats.githubStars ?? 0, fallbackStats.githubStars ?? 0),
  chromeRatingAverage:
    verifiedAverage(generatedStats.chromeRatingAverage) ?? verifiedAverage(fallbackStats.chromeRatingAverage),
  chromeRatingCount:
    verifiedCount(generatedStats.chromeRatingCount) ?? verifiedCount(fallbackStats.chromeRatingCount),
  fetchedAt: generatedStats.fetchedAt ?? "",
  verifiedAt: generatedStats.verifiedAt ?? fallbackStats.verifiedAt,
  source: generatedStats.source ?? fallbackStats.source ?? {},
};
