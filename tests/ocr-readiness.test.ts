import { describe, expect, it } from 'vitest';
import { ocrReadyForRecognition, ocrReadyToRetry } from '@/background/ocr-readiness';
import type { AssetStatus } from '@/engine/model/asset';
import type { OcrTier } from '@/engine/ocr/catalog';

function status(state: AssetStatus<OcrTier>['state']): AssetStatus<OcrTier> {
  return { id: 'standard', state, received: 22939968, total: 22939968, progress: 1 };
}

describe('OCR recognition readiness', () => {
  it.each(['ready', 'loaded'] as const)('accepts an installed bundle in %s', (state) => {
    expect(ocrReadyForRecognition(status(state))).toBe(true);
  });

  it('waits for an in-flight runtime instead of reporting a missing bundle', () => {
    // Cold start: recognize() created the runtime task but it has not resolved yet.
    expect(ocrReadyForRecognition(status('loading'))).toBe(true);
  });

  it.each(['ready', 'loaded'] as const)('retries pages when OCR reports %s', (state) => {
    expect(ocrReadyToRetry(status(state))).toBe(true);
  });

  it('does not retry on an in-flight runtime load or a failed download', () => {
    for (const state of ['loading', 'downloading', 'verifying', 'error'] as const) {
      expect(ocrReadyToRetry(status(state)), state).toBe(false);
    }
  });

  it.each(['absent', 'partial', 'downloading', 'verifying', 'error'] as const)(
    'still rejects %s as not ready',
    (state) => {
      expect(ocrReadyForRecognition(status(state))).toBe(false);
    },
  );
});
