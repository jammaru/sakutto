import { isFirefoxBuild } from '@/shared/browser';
import { createChromeOffscreenApi } from './chrome-offscreen';
import { createFirefoxEngineFrameApi } from './firefox-engine-frame';
import { OffscreenController } from './offscreen-lifecycle';

export function createEngineHostController(): OffscreenController {
  return new OffscreenController(
    isFirefoxBuild() ? createFirefoxEngineFrameApi() : createChromeOffscreenApi(),
  );
}
