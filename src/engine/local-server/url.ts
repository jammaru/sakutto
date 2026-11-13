export const DEFAULT_LOCAL_SERVER_URL = 'http://127.0.0.1:8080/v1';
export const DEFAULT_LOCAL_SERVER_TIMEOUT_MS = 120_000;
export const DEFAULT_LOCAL_SERVER_PARALLEL = 8;

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

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

function unbracket(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, '');
}

function stripTrailingDots(host: string): string {
  return host.replace(/\.+$/u, '');
}

function isLoopbackIpv4(host: string): boolean {
  return /^127(?:\.(?:\d{1,3})){3}$/u.test(host);
}

/**
 * IPv4-mapped IPv6 loopback, as the URL parser emits it (`[::ffff:7f00:1]`) and as typed
 * (`[::ffff:127.0.0.1]`). Other mapped addresses are remote.
 */
function isIpv4MappedLoopback(host: string): boolean {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(host);
  const dottedIp = dotted?.[1];
  if (dottedIp) return isLoopbackIpv4(dottedIp);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(host);
  const hiPart = hex?.[1];
  const loPart = hex?.[2];
  if (!hiPart || !loPart) return false;
  const hi = Number.parseInt(hiPart, 16);
  const lo = Number.parseInt(loPart, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return false;
  const a = (hi >> 8) & 0xff;
  const b = hi & 0xff;
  const c = (lo >> 8) & 0xff;
  const d = lo & 0xff;
  return isLoopbackIpv4(`${String(a)}.${String(b)}.${String(c)}.${String(d)}`);
}

export function isLoopbackHostname(hostname: string): boolean {
  const raw = hostname.trim().toLowerCase();
  const host = stripTrailingDots(unbracket(raw));
  if (LOOPBACK_NAMES.has(host) || LOOPBACK_NAMES.has(raw) || LOOPBACK_NAMES.has(unbracket(raw))) {
    return true;
  }
  if (isLoopbackIpv4(host)) return true;
  return isIpv4MappedLoopback(host);
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

/** Origin identity used to decide whether a URL change needs a fresh remote confirmation. */
export function serverOriginKey(url: string): string {
  return parseServerUrl(url)?.origin ?? url.trim();
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

export function normalizeParallel(
  value: unknown,
  fallback = DEFAULT_LOCAL_SERVER_PARALLEL,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(16, Math.max(1, Math.round(value)));
}
