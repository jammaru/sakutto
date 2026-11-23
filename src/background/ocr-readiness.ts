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

/**
 * OCR progress states that mean a reader may retry pages that failed while the bundle was
 * missing. A finished download (`ready`) is the first point recognition can succeed, even when
 * no runtime has been loaded yet; `loaded` covers the later runtime warm-up. `loading` is not a
 * transition to retry on: it is an in-flight task that the first recognition already waits for.
 */
export function ocrReadyToRetry(status: AssetStatus<OcrTier>): boolean {
  return status.state === 'ready' || status.state === 'loaded';
}
