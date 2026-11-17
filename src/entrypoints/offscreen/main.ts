import { browser } from 'wxt/browser';
import { readRuntimeLastError, safeSendResponse } from '@/shared/runtime-last-error';
import { EngineHost } from '@/engine/offscreen/host';
import {
  applyFirefoxWebGpuKickFlag,
  installFirefoxWebGpuKickWorkerOption,
} from '@/engine/wllama/firefox-webgpu-kick';
import { isFirefoxBuild } from '@/shared/browser';
import { installAdapterNoiseFilter, probeCapabilities } from '@/shared/capabilities';
import { applyWebGpuDebugProfileFromHref } from '@/shared/gpu-diagnostic';
import { isEngineProbeRequest, type EngineProbeResponse } from '@/shared/messages';

installAdapterNoiseFilter();
applyWebGpuDebugProfileFromHref(typeof location !== 'undefined' ? location.href : '');
applyFirefoxWebGpuKickFlag();
if (isFirefoxBuild()) {
  installFirefoxWebGpuKickWorkerOption();
}

const host = new EngineHost();
const FRAME_READY = 'sakutto-engine-frame';

browser.runtime.onConnect.addListener((port) => {
  host.handlePort(port);
});

if (typeof window !== 'undefined' && window.parent !== window) {
  try {
    window.parent.postMessage({ source: FRAME_READY, type: 'ready' }, window.location.origin);
  } catch {
    // The embedding frame went away while the offscreen document was opening.
  }
  readRuntimeLastError();
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id) return false;
  if (sender.tab) return false;
  if (!isEngineProbeRequest(message)) return false;

  void probeCapabilities().then(
    (capabilities) => {
      safeSendResponse(sendResponse, {
        source: 'offscreen',
        capabilities,
      } satisfies EngineProbeResponse);
    },
    () => {
      safeSendResponse(sendResponse, null);
    },
  );
  return true;
});
