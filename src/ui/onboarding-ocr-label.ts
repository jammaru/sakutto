import type { ModelStatus } from '@/shared/engine-status';
import { OCR_TIER_CATALOG, type OcrTier } from '@/engine/ocr/catalog';
import { t } from '@/shared/i18n';
import { formatByteSize } from './format';
import { downloadPercent, substituteMessageTokens } from './ocr-download';

/** PLaMo and OCR share the same byte/progress shape even though their IDs differ. */
export type SetupStatus = Pick<ModelStatus, 'state' | 'received' | 'total' | 'progress'>;

export interface OnboardingSetupLines {
  plamo: string;
  ocr: string;
}

function plamoLine(status: SetupStatus | null): string {
  if (status === null) return t('runtimeWaiting');
  if (status.state === 'ready' || status.state === 'loaded') return t('onboardingPlamoReady');

  if (status.state === 'downloading') {
    const percent = downloadPercent(status);
    const received = formatByteSize(status.received);
    const total = formatByteSize(status.total);
    return substituteMessageTokens(t('runtimeDownloading', [percent, received, total]), {
      PERCENT: percent,
      RECEIVED: received,
      TOTAL: total,
    });
  }

  if (status.state === 'verifying') {
    return `${t('runtimeVerifying')} ${formatByteSize(status.received)} / ${formatByteSize(status.total)}`;
  }
  if (status.state === 'loading') return t('runtimeLoading');
  return t('runtimeWaiting');
}

/**
 * A stored PLaMo model must not swallow the OCR transfer: each bundle keeps its own line while
 * onboarding downloads, so the reader can see exactly what is still being added.
 */
function ocrLine(status: SetupStatus | null, tier: OcrTier): string {
  if (status?.state === 'ready' || status?.state === 'loaded') return t('onboardingOcrReady');

  const size = formatByteSize(OCR_TIER_CATALOG[tier].size);
  const percent = downloadPercent(status ?? { progress: 0 });
  return substituteMessageTokens(t('onboardingOcrDownloading', [size, percent]), {
    SIZE: size,
    PERCENT: percent,
  });
}

export function onboardingSetupLines(
  plamo: SetupStatus | null,
  ocr: SetupStatus | null,
  tier: OcrTier,
): OnboardingSetupLines {
  return { plamo: plamoLine(plamo), ocr: ocrLine(ocr, tier) };
}
