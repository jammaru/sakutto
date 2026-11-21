import { describe, expect, it } from 'vitest';
import { combinedSetupProgress, isOcrResult, isOcrStatus } from '@/shared/ocr';

const plamo = { received: 80, total: 100, state: 'ready' } as const;
const ocr = { received: 10, total: 20, state: 'downloading' } as const;

describe('combined OCR onboarding progress', () => {
  it('weights bytes across both downloads and is not ready after only PLaMo', () => {
    expect(combinedSetupProgress(plamo, ocr)).toEqual({
      received: 90,
      total: 120,
      progress: 0.75,
      state: 'downloading',
    });
  });

  it('requires both bundles for readiness and surfaces either failure', () => {
    expect(combinedSetupProgress(plamo, { ...ocr, received: 20, state: 'loaded' }).state).toBe(
      'ready',
    );
    expect(combinedSetupProgress(plamo, { ...ocr, state: 'error' }).state).toBe('error');
  });
});

describe('OCR payload validation', () => {
  it('accepts tier statuses and rejects translation model statuses', () => {
    expect(
      isOcrStatus({ id: 'standard', state: 'partial', received: 1, total: 2, progress: 0.5 }),
    ).toBe(true);
    expect(
      isOcrStatus({
        id: 'plamo-3-translate-0.8b-q4_k_m',
        state: 'ready',
        received: 2,
        total: 2,
        progress: 1,
      }),
    ).toBe(false);
  });

  it('accepts structured OCR results and rejects malformed ones', () => {
    expect(isOcrResult({ text: '原文', regions: [], lines: [] })).toBe(true);
    expect(isOcrResult({ text: 42, regions: [], lines: [] })).toBe(false);
  });
});
