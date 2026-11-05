import type { EngineStatus } from '@/shared/engine-status';
import type { MessageKey } from '@/shared/i18n';
import { isChromeLanguage, isChromeOnlyLanguage } from '@/shared/languages';
import { formatByteSize } from './format';

export interface RuntimeLabel {
  key: MessageKey;
  substitutions?: string[];
}

export function runtimeLabel(input: {
  status: EngineStatus | null;
  pageSimple: boolean;
  targetLanguage: string;
}): RuntimeLabel {
  const { status, pageSimple, targetLanguage } = input;
  if (!status) return { key: 'runtimeChecking' };

  const state = status.model.state;
  if (state === 'downloading') {
    const percent = String(Math.max(0, Math.min(100, Math.round(status.model.progress * 100))));
    return {
      key: 'runtimeDownloading',
      substitutions: [
        percent,
        formatByteSize(status.model.received),
        formatByteSize(status.model.total),
      ],
    };
  }
  if (state === 'verifying') return { key: 'runtimeVerifying' };
  if (state === 'loading') return { key: 'runtimeLoading' };

  if (isChromeOnlyLanguage(targetLanguage)) return { key: 'runtimeSimple' };

  if (status.plamoReady && !pageSimple) {
    return { key: status.backend === 'webgpu' ? 'runtimePlamoGpu' : 'runtimePlamoCpu' };
  }

  if (pageSimple || (isChromeLanguage(targetLanguage) && !status.plamoReady)) {
    return { key: 'runtimeSimple' };
  }

  if (state === 'error') return { key: 'runtimeError' };
  return { key: 'runtimeWaiting' };
}
