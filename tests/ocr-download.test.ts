import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: { i18n: { getMessage: () => '', getUILanguage: () => 'en' } },
}));

const { DEFAULT_OCR_TIER, OCR_TIER_CATALOG } = await import('@/engine/ocr/catalog');
const { formatByteSize } = await import('@/ui/format');
const { ocrDownloadLabel, ocrDownloadProgressLabel, ocrTierOf } = await import('@/ui/ocr-download');

describe('inline OCR download copy', () => {
  it('falls back to the default tier for a missing or stale setting', () => {
    expect(ocrTierOf(undefined)).toBe(DEFAULT_OCR_TIER);
    expect(ocrTierOf('bogus')).toBe(DEFAULT_OCR_TIER);
    expect(ocrTierOf('high')).toBe('high');
  });

  it('labels the button with the size of the tier that will be downloaded', () => {
    for (const tier of ['standard', 'high'] as const) {
      const expected =
        'Download OCR model (about ' + formatByteSize(OCR_TIER_CATALOG[tier].size) + ')';
      expect(ocrDownloadLabel(tier)).toBe(expected);
      expect(ocrDownloadLabel(tier)).not.toMatch(/[Ａ-Ｚａ-ｚ０-９]/u);
    }
  });

  it('clamps progress to a half-width percentage', () => {
    expect(ocrDownloadProgressLabel({ progress: 0.426 })).toBe('Downloading OCR model: 43%');
    expect(ocrDownloadProgressLabel({ progress: -1 })).toBe('Downloading OCR model: 0%');
    expect(ocrDownloadProgressLabel({ progress: 4 })).toBe('Downloading OCR model: 100%');
    expect(ocrDownloadProgressLabel({ progress: Number.NaN })).toBe('Downloading OCR model: 0%');
  });
});
