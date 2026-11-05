export const WLLAMA_ASSET_DIRECTORY = 'vendor/wllama';

export type RuntimeUrlResolver = (path: string) => string;

export interface WllamaAssetUrls {
  library: string;
  wasm: string;
  worker: string;
  module: string;
  pthread: string;
  compatWasm: string;
  compatModule: string;
  compatPthread: string;
}

export function resolveWllamaAssetUrls(getUrl: RuntimeUrlResolver): WllamaAssetUrls {
  const asset = (name: string): string => getUrl(`${WLLAMA_ASSET_DIRECTORY}/${name}`);

  return {
    library: asset('wllama.js'),
    wasm: asset('wllama.wasm'),
    worker: asset('wllama-worker.js'),
    module: asset('wllama-module.js'),
    pthread: asset('wllama-pthread.js'),
    compatWasm: asset('wllama-compat.wasm'),
    compatModule: asset('wllama-compat-module.js'),
    compatPthread: asset('wllama-compat-pthread.js'),
  };
}

export function isExtensionAssetUrl(url: string, extensionBase: string): boolean {
  try {
    const target = new URL(url);
    const base = new URL(extensionBase);
    return target.protocol === base.protocol && target.host === base.host;
  } catch {
    return false;
  }
}
