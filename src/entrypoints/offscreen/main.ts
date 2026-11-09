import { browser } from 'wxt/browser';
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
  window.parent.postMessage({ source: FRAME_READY, type: 'ready' }, window.location.origin);
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id) return false;
  if (sender.tab) return false;
  if (!isEngineProbeRequest(message)) return false;

  void probeCapabilities().then(
    (capabilities) =>
      sendResponse({ source: 'offscreen', capabilities } satisfies EngineProbeResponse),
    () => sendResponse(null),
  );
  return true;
});
