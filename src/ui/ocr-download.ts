import type { AssetStatus } from '@/engine/model/asset';
import { DEFAULT_OCR_TIER, OCR_TIER_CATALOG, isOcrTier, type OcrTier } from '@/engine/ocr/catalog';
import { t } from '@/shared/i18n';
import { formatByteSize } from './format';

/** Chrome substitutes named placeholders; keep the JSON fallback honest too. */
function substitute(message: string, token: string, value: string): string {
  return message.replace('$' + token + '$', value);
}

/** The live tier setting can be stale or absent; every download starts from a valid tier. */
export function ocrTierOf(value: unknown): OcrTier {
  return isOcrTier(value) ? value : DEFAULT_OCR_TIER;
}

/** Inline prompt copy: the size comes from the same tier the download request will use. */
export function ocrDownloadLabel(tier: OcrTier): string {
  const size = formatByteSize(OCR_TIER_CATALOG[tier].size);
  return substitute(t('ocrDownloadInline', [size]), 'SIZE', size);
}

/** Percent-only progress, so the prompt stays useful on a narrow popup or a page overlay. */
export function ocrDownloadProgressLabel(status: Pick<AssetStatus<OcrTier>, 'progress'>): string {
  const percent = Number.isFinite(status.progress)
    ? Math.min(100, Math.max(0, Math.round(status.progress * 100)))
    : 0;
  const label = String(percent);
  return substitute(t('ocrDownloadProgress', [label]), 'PERCENT', label);
}
