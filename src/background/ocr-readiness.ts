import type { AssetStatus } from '@/engine/model/asset';
import type { OcrTier } from '@/engine/ocr/catalog';

/**
 * OCR states from which recognition may proceed.
 *
 * `loading` means the runtime is already initializing in the offscreen host. Recognition is
 * serialized behind that in-flight task, so a second surface arriving during cold start must
 * wait for it instead of reporting "OCR models are not downloaded". Only an absent (or unusable)
 * bundle is actionable as model-missing.
 */
export function ocrReadyForRecognition(status: AssetStatus<OcrTier>): boolean {
  return status.state === 'ready' || status.state === 'loaded' || status.state === 'loading';
}
