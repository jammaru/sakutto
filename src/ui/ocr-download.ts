import type { AssetStatus } from '@/engine/model/asset';
import { DEFAULT_OCR_TIER, OCR_TIER_CATALOG, isOcrTier, type OcrTier } from '@/engine/ocr/catalog';
import { t } from '@/shared/i18n';
import { formatByteSize } from './format';

/** Chrome substitutes named placeholders; keep the JSON fallback honest too. */
export function substituteMessageTokens(
  message: string,
  values: Readonly<Record<string, string>>,
): string {
  let out = message;
  for (const [token, value] of Object.entries(values)) {
    out = out.replaceAll('$' + token + '$', value);
  }
  return out;
}

/** The live tier setting can be stale or absent; every download starts from a valid tier. */
export function ocrTierOf(value: unknown): OcrTier {
  return isOcrTier(value) ? value : DEFAULT_OCR_TIER;
}

/** Inline prompt copy: the size comes from the same tier the download request will use. */
export function ocrDownloadLabel(tier: OcrTier): string {
  const size = formatByteSize(OCR_TIER_CATALOG[tier].size);
  return substituteMessageTokens(t('ocrDownloadInline', [size]), { SIZE: size });
}

/** Clamped half-width percent shared by the inline prompt and the onboarding lines. */
export function downloadPercent(status: { progress: number }): string {
  const percent = Number.isFinite(status.progress)
    ? Math.min(100, Math.max(0, Math.round(status.progress * 100)))
    : 0;
  return String(percent);
}

/** Percent-only progress, so the prompt stays useful on a narrow popup or a page overlay. */
export function ocrDownloadProgressLabel(status: Pick<AssetStatus<OcrTier>, 'progress'>): string {
  const percent = downloadPercent(status);
  return substituteMessageTokens(t('ocrDownloadProgress', [percent]), { PERCENT: percent });
}
