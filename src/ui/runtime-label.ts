import { FOLDER_PERMISSION_ERROR } from '@/engine/model/folder-permission';
import { hasBuiltInTranslatorUi } from '@/shared/browser';
import type { EngineStatus } from '@/shared/engine-status';
import type { MessageKey } from '@/shared/i18n';
import { isChromeOnlyLanguage, isPlamoOnlyTarget } from '@/shared/languages';
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

  if (status.engineSource === 'local-server') return { key: 'runtimeLocalServer' };

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

  // Only a pair the model cannot translate at all is handled by Chrome, and that engine
  // is the page's real translator rather than a stand-in for a warming model.
  if (
    hasBuiltInTranslatorUi() &&
    !isPlamoOnlyTarget(targetLanguage) &&
    (isChromeOnlyLanguage(targetLanguage) || pageSimple)
  ) {
    return { key: 'runtimeChrome' };
  }

  if (status.plamoReady) {
    if (status.backend === 'webgpu') return { key: 'runtimePlamoGpu' };
    return { key: status.gpuFallback === true ? 'runtimePlamoGpuFallback' : 'runtimePlamoCpu' };
  }

  // A missing folder grant has its own restore card. Do not also say the model
  // failed to load — the GGUF is typically still on disk.
  if (state === 'error' && status.model.error !== FOLDER_PERMISSION_ERROR) {
    return { key: 'runtimeError' };
  }
  return { key: 'runtimeWaiting' };
}
