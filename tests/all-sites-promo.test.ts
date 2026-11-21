import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (key: string) => {
          if (!state.storage.has(key)) return {};
          return { [key]: state.storage.get(key) };
        },
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) state.storage.set(key, value);
        },
      },
    },
  },
}));

const {
  ALL_SITES_PROMO_OPEN_COUNT_KEY,
  readAllSitesPromoOpenCount,
  resolveAllSitesPromoPlacement,
  saveAllSitesPromoOpenCount,
} = await import('@/dom/all-sites-promo');

beforeEach(() => {
  state.storage.clear();
});

describe('all-sites promo placement', () => {
  it('keeps the first popup open at the top', () => {
    expect(
      resolveAllSitesPromoPlacement({
        openCount: 1,
        allSitesGranted: false,
        showHint: true,
      }),
    ).toBe('top');
  });

  it('treats an unseen count (zero) as the first open', () => {
    expect(
      resolveAllSitesPromoPlacement({
        openCount: 0,
        allSitesGranted: false,
        showHint: true,
      }),
    ).toBe('top');
  });

  it('moves the hint to the bottom from the second open onward', () => {
    for (const openCount of [2, 3, 10]) {
      expect(
        resolveAllSitesPromoPlacement({
          openCount,
          allSitesGranted: false,
          showHint: true,
        }),
      ).toBe('bottom');
    }
  });

  it('hides the hint once all-sites access is granted', () => {
    expect(
      resolveAllSitesPromoPlacement({
        openCount: 1,
        allSitesGranted: true,
        showHint: true,
      }),
    ).toBe('hidden');
    expect(
      resolveAllSitesPromoPlacement({
        openCount: 5,
        allSitesGranted: true,
        showHint: true,
      }),
    ).toBe('hidden');
  });

  it('hides the hint when the current page does not show it', () => {
    expect(
      resolveAllSitesPromoPlacement({
        openCount: 3,
        allSitesGranted: false,
        showHint: false,
      }),
    ).toBe('hidden');
  });
});

describe('popup markup slots', () => {
  const popup = readFileSync(new URL('../src/entrypoints/popup/App.svelte', import.meta.url), {
    encoding: 'utf8',
  });

  it('renders the top slot before mail access and captions', () => {
    const top = popup.indexOf("allSitesPromoPlacement === 'top'");
    const mail = popup.indexOf('data-sakutto="mail-permission"');
    const captions = popup.indexOf('data-sakutto="video-captions"');
    expect(top).toBeGreaterThan(-1);
    expect(top).toBeLessThan(mail);
    expect(top).toBeLessThan(captions);
  });

  it('renders the bottom slot after typed text translation and before the footer', () => {
    const typed = popup.indexOf('onclick={openTyped}');
    const bottom = popup.indexOf("allSitesPromoPlacement === 'bottom'");
    const footer = popup.indexOf('<footer class="footer">');
    expect(typed).toBeGreaterThan(-1);
    expect(bottom).toBeGreaterThan(typed);
    expect(footer).toBeGreaterThan(bottom);
  });
});

describe('all-sites promo open count persistence', () => {
  it('starts at zero when nothing is stored', async () => {
    await expect(readAllSitesPromoOpenCount()).resolves.toBe(0);
  });

  it('round-trips the count under its storage key', async () => {
    const { browser } = await import('wxt/browser');
    const set = vi.spyOn(browser.storage.local, 'set');
    await saveAllSitesPromoOpenCount(2);
    expect(set).toHaveBeenCalledWith({ [ALL_SITES_PROMO_OPEN_COUNT_KEY]: 2 });
    expect(state.storage.get(ALL_SITES_PROMO_OPEN_COUNT_KEY)).toBe(2);
    await expect(readAllSitesPromoOpenCount()).resolves.toBe(2);
  });

  it('ignores malformed stored values', async () => {
    state.storage.set(ALL_SITES_PROMO_OPEN_COUNT_KEY, -3);
    await expect(readAllSitesPromoOpenCount()).resolves.toBe(0);
    state.storage.set(ALL_SITES_PROMO_OPEN_COUNT_KEY, 'many');
    await expect(readAllSitesPromoOpenCount()).resolves.toBe(0);
    state.storage.set(ALL_SITES_PROMO_OPEN_COUNT_KEY, 1.8);
    await expect(readAllSitesPromoOpenCount()).resolves.toBe(1);
  });
});
