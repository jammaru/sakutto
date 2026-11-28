const formatter = new Intl.NumberFormat("en-US");

/**
 * Round a raw count down to a quiet, readable bucket. Never rounds up: the
 * displayed figure is always a lower bound of the fetched value.
 */
export function formatSocialStat(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0+";

  let bucket: number;
  if (value >= 1000) bucket = Math.floor(value / 1000) * 1000;
  else if (value >= 100) bucket = Math.floor(value / 100) * 100;
  else if (value >= 10) bucket = Math.floor(value / 10) * 10;
  else bucket = Math.floor(value);

  return `${formatter.format(bucket)}+`;
}
