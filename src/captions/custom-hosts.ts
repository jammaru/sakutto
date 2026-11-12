export const CAPTION_CUSTOM_SCRIPT_ID = 'sakutto-caption-custom-hosts';
export const CAPTION_CUSTOM_SCRIPT_FILE = 'content-scripts/content.js';

const SITE_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

/**
 * User-typed domain for caption translation. `example.com` or `*.example.com`.
 * No `file:` / `chrome:` / paths / bare wildcards.
 */
export function parseCaptionCustomHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (/^(file|chrome|chrome-extension|about|javascript|data|blob):/iu.test(trimmed)) return null;
  if (trimmed === '*' || trimmed === '*.*' || trimmed.includes('**')) return null;

  let wildcard = false;
  let candidate = trimmed;
  if (candidate.startsWith('*.')) {
    wildcard = true;
    candidate = candidate.slice(2);
  }

  if (candidate.includes('://') || candidate.includes('/')) {
    try {
      const url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (url.pathname !== '/' && url.pathname.length > 0) return null;
      if (url.search.length > 0 || url.hash.length > 0) return null;
      candidate = url.hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  candidate = candidate.replace(/^www\./, '');
  if (candidate.startsWith('*.')) return null;
  if (!SITE_HOST.test(candidate)) return null;
  // `*.com` / `*.jp` would match every host under that TLD.
  if (wildcard && !candidate.includes('.')) return null;
  return wildcard ? `*.${candidate}` : candidate;
}

export function captionCustomHostOrigins(entry: string): string[] {
  if (entry.startsWith('*.')) {
    const base = entry.slice(2);
    return [`https://*.${base}/*`, `http://*.${base}/*`, `https://${base}/*`, `http://${base}/*`];
  }
  return [`https://${entry}/*`, `http://${entry}/*`];
}

export function hostMatchesCaptionCustom(host: string, entries: readonly string[]): boolean {
  const normalized = host.replace(/^www\./, '').toLowerCase();
  for (const entry of entries) {
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      if (normalized === base || normalized.endsWith(`.${base}`)) return true;
      continue;
    }
    if (normalized === entry.replace(/^www\./, '')) return true;
    if (host.toLowerCase() === entry) return true;
  }
  return false;
}

export function normalizeCaptionCustomHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hosts: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const parsed = parseCaptionCustomHost(item);
    if (parsed && !hosts.includes(parsed)) hosts.push(parsed);
  }
  return hosts;
}
