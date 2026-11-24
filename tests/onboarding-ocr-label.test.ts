import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: { i18n: { getMessage: () => '', getUILanguage: () => 'en' } },
}));

const { DEFAULT_OCR_TIER, OCR_TIER_CATALOG } = await import('@/engine/ocr/catalog');
const { formatByteSize } = await import('@/ui/format');
const { onboardingSetupLines } = await import('@/ui/onboarding-ocr-label');

const ready = { state: 'ready', received: 100, total: 100, progress: 1 } as const;
const ocrSize = formatByteSize(OCR_TIER_CATALOG[DEFAULT_OCR_TIER].size);

describe('onboarding setup lines', () => {
  it('marks a stored PLaMo ready while the OCR download keeps its own progress line', () => {
    const lines = onboardingSetupLines(
      ready,
      { state: 'downloading', received: 10_000_000, total: 22_939_968, progress: 0.426 },
      DEFAULT_OCR_TIER,
    );
    expect(lines.plamo).toBe('Translation model (PLaMo): already on this device');
    expect(lines.ocr).toBe(
      `Downloading the OCR model (for scanned PDFs and images, about ${ocrSize}): 43%`,
    );
  });

  it('shows each active download its own bytes and percent', () => {
    const lines = onboardingSetupLines(
      { state: 'downloading', received: 100_000_000, total: 200_000_000, progress: 0.5 },
      { state: 'downloading', received: 5_000_000, total: 20_000_000, progress: 0.25 },
      DEFAULT_OCR_TIER,
    );
    expect(lines.plamo).toBe('Downloading 50% (100 MB / 200 MB)');
    expect(lines.ocr).toContain('25%');
    expect(lines.ocr).not.toContain('100 MB / 200 MB');
  });

  it('labels a fetched OCR bundle and waits when neither status is known yet', () => {
    expect(onboardingSetupLines(ready, ready, DEFAULT_OCR_TIER).ocr).toBe(
      'OCR model: already on this device',
    );
    const waiting = onboardingSetupLines(null, null, DEFAULT_OCR_TIER);
    expect(waiting.plamo).toBe('Waiting for the model');
    expect(waiting.ocr).toContain('0%');
  });
});
