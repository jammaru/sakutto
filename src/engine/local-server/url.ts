export const DEFAULT_LOCAL_SERVER_URL = 'http://127.0.0.1:8080/v1';
export const DEFAULT_LOCAL_SERVER_TIMEOUT_MS = 120_000;

export const LOCAL_SERVER_PRESETS = {
  mlx: {
    id: 'mlx',
    url: 'http://127.0.0.1:8080/v1',
  },
  'lm-studio': {
    id: 'lm-studio',
    url: 'http://127.0.0.1:1234/v1',
  },
} as const;

export type LocalServerPresetId = keyof typeof LOCAL_SERVER_PRESETS;

export interface ParsedServerUrl {
  href: string;
  origin: string;
  protocol: 'http:' | 'https:';
  hostname: string;
  completionsUrl: string;
  modelsUrl: string;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, '');
  if (LOOPBACK_NAMES.has(host) || LOOPBACK_NAMES.has(hostname.trim().toLowerCase())) return true;
  return /^127(?:\.(?:\d{1,3})){3}$/u.test(host);
}

export function parseServerUrl(value: string): ParsedServerUrl | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.hostname.length === 0) return null;

  let path = parsed.pathname.replace(/\/+$/u, '');
  if (path === '' || path === '/') path = '/v1';
  else if (!path.endsWith('/v1')) path = `${path}/v1`;

  const base = `${parsed.origin}${path}`;
  return {
    href: base,
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    completionsUrl: `${base}/completions`,
    modelsUrl: `${base}/models`,
  };
}

export function normalizeServerUrl(value: string, fallback = DEFAULT_LOCAL_SERVER_URL): string {
  return parseServerUrl(value)?.href ?? fallback;
}

export function isRemoteServerUrl(value: string): boolean {
  const parsed = parseServerUrl(value);
  if (!parsed) return true;
  return !isLoopbackHostname(parsed.hostname);
}

function hostMatchPattern(protocol: string, hostname: string): string {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `${protocol}//${host}/*`;
}

/** The origin that must actually be reachable for this URL. Loopback aliases are extra. */
export function primaryOriginPattern(url: string): string | null {
  const parsed = parseServerUrl(url);
  if (!parsed) return null;
  return hostMatchPattern(parsed.protocol, parsed.hostname);
}

export function originPatternsFor(url: string): string[] {
  const parsed = parseServerUrl(url);
  if (!parsed) return [];
  const protocol = parsed.protocol;
  if (isLoopbackHostname(parsed.hostname)) {
    return [`${protocol}//127.0.0.1/*`, `${protocol}//localhost/*`, `${protocol}//[::1]/*`];
  }
  return [hostMatchPattern(protocol, parsed.hostname)];
}

export function normalizeTimeoutMs(
  value: unknown,
  fallback = DEFAULT_LOCAL_SERVER_TIMEOUT_MS,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(600_000, Math.max(5_000, Math.round(value)));
}

export function normalizeApiKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeModelName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
