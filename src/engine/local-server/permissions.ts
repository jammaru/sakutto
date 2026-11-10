import { browser } from 'wxt/browser';
import { originPatternsFor, parseServerUrl, primaryOriginPattern } from './url';

export async function requestServerPermission(url: string): Promise<boolean> {
  const origins = originPatternsFor(url);
  if (origins.length === 0) return false;
  const primary = primaryOriginPattern(url);
  if (primary) {
    const alreadyPrimary = await browser.permissions
      .contains({ origins: [primary] })
      .catch(() => false);
    if (alreadyPrimary) return true;
  }
  const already = await browser.permissions.contains({ origins }).catch(() => false);
  if (already) return true;
  return browser.permissions.request({ origins }).catch(() => false);
}

export function serverOriginLabel(url: string): string {
  return parseServerUrl(url)?.origin ?? url;
}
