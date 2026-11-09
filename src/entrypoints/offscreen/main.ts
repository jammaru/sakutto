import { browser } from 'wxt/browser';
import { EngineHost } from '@/engine/offscreen/host';
import { installAdapterNoiseFilter, probeCapabilities } from '@/shared/capabilities';
import { applyWebGpuDebugProfileFromHref } from '@/shared/gpu-diagnostic';
import { isEngineProbeRequest, type EngineProbeResponse } from '@/shared/messages';

installAdapterNoiseFilter();
applyWebGpuDebugProfileFromHref(typeof location !== 'undefined' ? location.href : '');

const host = new EngineHost();

browser.runtime.onConnect.addListener((port) => {
  host.handlePort(port);
});

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
