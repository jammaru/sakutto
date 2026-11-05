import { browser } from 'wxt/browser';
import type { GlossaryEntry } from '@/engine/types';
import { normalizeGlossary } from '@/shared/glossary';
import { isTargetLanguage, type TargetLanguage } from '@/shared/languages';
import { isRecord } from '@/shared/object';
import type { DisplayMode } from '@/shared/settings';

const SITE_RULES_KEY = 'siteRules';

export type SiteAuto = 'ask' | 'always' | 'never';

export interface SiteRule {
  host: string;
  auto: SiteAuto;
  display?: DisplayMode;
  targetLanguage?: TargetLanguage;
  glossary?: GlossaryEntry[];
}

export function pageHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeSiteRule(host: string, value: unknown): SiteRule | null {
  const normalizedHost = host.trim().toLowerCase();
  if (normalizedHost.length === 0 || !isRecord(value)) return null;

  const rule: SiteRule = {
    host: normalizedHost,
    auto: value.auto === 'always' || value.auto === 'never' ? value.auto : 'ask',
  };

  if (value.display === 'bilingual' || value.display === 'replace') rule.display = value.display;
  if (isTargetLanguage(value.targetLanguage)) rule.targetLanguage = value.targetLanguage;
  const glossary = normalizeGlossary(value.glossary);
  if (glossary.length > 0) rule.glossary = glossary;
  return rule;
}

export function normalizeSiteRules(value: unknown): Record<string, SiteRule> {
  if (!isRecord(value)) return {};

  const rules: Record<string, SiteRule> = {};
  for (const [host, rule] of Object.entries(value)) {
    const normalized = normalizeSiteRule(host, rule);
    if (normalized) rules[normalized.host] = normalized;
  }
  return rules;
}

export async function loadSiteRules(): Promise<Record<string, SiteRule>> {
  const stored = await browser.storage.local.get(SITE_RULES_KEY);
  return normalizeSiteRules(stored[SITE_RULES_KEY]);
}

export async function loadSiteRule(host: string): Promise<SiteRule> {
  const rules = await loadSiteRules();
  return (
    rules[host] ?? {
      host,
      auto: 'ask',
    }
  );
}

let siteWriteQueue: Promise<unknown> = Promise.resolve();

export function saveSiteRule(rule: SiteRule): Promise<SiteRule> {
  const operation = siteWriteQueue.then(async () => {
    const rules = await loadSiteRules();
    const next = normalizeSiteRule(rule.host, rule);
    if (!next) return rule;
    rules[next.host] = next;
    await browser.storage.local.set({ [SITE_RULES_KEY]: rules });
    return next;
  });

  siteWriteQueue = operation.catch(() => undefined);
  return operation;
}

export function subscribeSiteRules(
  listener: (rules: Record<string, SiteRule>) => void,
): () => void {
  const handleChanges = (
    changes: Record<string, { newValue?: unknown }>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    const change = changes[SITE_RULES_KEY];
    if (!change) return;
    listener(normalizeSiteRules(change.newValue));
  };

  browser.storage.onChanged.addListener(handleChanges);
  return () => browser.storage.onChanged.removeListener(handleChanges);
}

const SITE_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

export function isSiteHost(host: unknown): host is string {
  return typeof host === 'string' && SITE_HOST.test(host);
}

/** Origins to request when the user turns on translation for the open page. */
export function siteAccessOrigins(pageUrl: string): string[] | null {
  const host = pageHost(pageUrl);
  const pattern = originPattern(pageUrl);
  if (!host || !pattern || !isSiteHost(host)) return null;
  const origins = [`https://${host}/*`, `http://${host}/*`];
  if (!origins.includes(pattern)) origins.push(pattern);
  return origins;
}

/** Origins for a grant request, or null when the tab is not that host. */
export function grantOriginsFor(tabUrl: string | undefined, host: string): string[] | null {
  if (!tabUrl || pageHost(tabUrl) !== host) return null;
  return siteAccessOrigins(tabUrl);
}

export function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}
