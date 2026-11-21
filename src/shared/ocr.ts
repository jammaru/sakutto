import type { AssetStatus } from '@/engine/model/asset';
import type { ModelState, ModelStatus } from '@/shared/engine-status';
import { isOcrTier, type OcrTier } from '@/engine/ocr/catalog';
import type { OcrResult } from '@/engine/ocr/types';
import { isRecord } from './object';

const OCR_STATES: ReadonlySet<string> = new Set<ModelState>([
  'absent',
  'partial',
  'downloading',
  'verifying',
  'ready',
  'loading',
  'loaded',
  'error',
]);

export function isOcrStatus(value: unknown): value is AssetStatus<OcrTier> {
  return (
    isRecord(value) &&
    isOcrTier(value.id) &&
    typeof value.state === 'string' &&
    OCR_STATES.has(value.state) &&
    typeof value.received === 'number' &&
    Number.isFinite(value.received) &&
    typeof value.total === 'number' &&
    Number.isFinite(value.total) &&
    typeof value.progress === 'number' &&
    Number.isFinite(value.progress) &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

export function isOcrResult(value: unknown): value is OcrResult {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    Array.isArray(value.regions) &&
    value.regions.every(
      (region) =>
        isRecord(region) &&
        typeof region.text === 'string' &&
        typeof region.recognitionConfidence === 'number' &&
        Array.isArray(region.quad),
    ) &&
    Array.isArray(value.lines) &&
    value.lines.every(
      (line) =>
        isRecord(line) &&
        (line.orientation === 'horizontal' || line.orientation === 'vertical') &&
        Array.isArray(line.items),
    )
  );
}

export interface CombinedSetupProgress {
  received: number;
  total: number;
  progress: number;
  state: ModelState;
}

/** Byte-weighted PLaMo + OCR onboarding progress, with readiness requiring both bundles. */
export function combinedSetupProgress(
  plamo: Pick<ModelStatus, 'received' | 'total' | 'state'>,
  ocr: Pick<AssetStatus<OcrTier>, 'received' | 'total' | 'state'>,
): CombinedSetupProgress {
  const received = plamo.received + ocr.received;
  const total = plamo.total + ocr.total;
  const ready = (state: ModelState): boolean => state === 'ready' || state === 'loaded';
  const state: ModelState =
    plamo.state === 'error' || ocr.state === 'error'
      ? 'error'
      : ready(plamo.state) && ready(ocr.state)
        ? 'ready'
        : plamo.state === 'loading' || ocr.state === 'loading'
          ? 'loading'
          : plamo.state === 'verifying' || ocr.state === 'verifying'
            ? 'verifying'
            : plamo.state === 'downloading' || ocr.state === 'downloading'
              ? 'downloading'
              : received > 0
                ? 'partial'
                : 'absent';
  return { received, total, progress: total > 0 ? Math.min(1, received / total) : 0, state };
}
