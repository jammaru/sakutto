import { browser } from 'wxt/browser';
import { isExtensionAssetUrl } from './assets';

export interface WllamaLogger {
  debug: (...data: unknown[]) => void;
  log: (...data: unknown[]) => void;
  warn: (...data: unknown[]) => void;
  error: (...data: unknown[]) => void;
}

export interface WllamaConfig {
  suppressNativeLog?: boolean;
  logger?: WllamaLogger;
  parallelDownloads?: number;
  allowOffline?: boolean;
}

export interface WllamaAssets {
  default: string;
  'wllama.worker.js': string;
  'wllama.module.js': string;
  'wllama.pthread.js': string;
  'wllama.compat.js': string;
  'wllama.compat.pthread.js': string;
  'wllama.compat.wasm': string;
}

export interface WllamaLoadParams {
  n_ctx?: number;
  n_threads?: number;
  n_gpu_layers?: number;
  n_parallel?: number;
  n_batch?: number;
  n_ubatch?: number;
  cont_batching?: boolean;
  flash_attn?: boolean;
  use_mmap?: boolean;
  use_mlock?: boolean;
  warmup?: boolean;
  ctx_shift?: boolean;
}

export interface WllamaCompletionChunk {
  choices?: ReadonlyArray<{ text?: string }>;
}

export interface WllamaCompletionParams {
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  cache_prompt?: boolean;
  stop?: string | readonly string[];
  stream?: boolean;
  abortSignal?: AbortSignal;
  onData?: (chunk: WllamaCompletionChunk) => void;
}

export interface Wllama {
  isModelLoaded(): boolean;
  loadModel(blobs: Blob[], params?: WllamaLoadParams): Promise<void>;
  createCompletion(
    params: WllamaCompletionParams & {
      stream: true;
      onData: (chunk: WllamaCompletionChunk) => void;
    },
  ): Promise<void>;
  exit(): Promise<void>;
}

export interface WllamaModule {
  Wllama: new (assets: WllamaAssets, config?: WllamaConfig) => Wllama;
}

export type WllamaModuleLoader = (url: string) => Promise<WllamaModule>;

function isWllamaModule(value: unknown): value is WllamaModule {
  if (typeof value !== 'object' || value === null || !('Wllama' in value)) return false;
  return typeof value.Wllama === 'function';
}

export async function loadWllamaModule(url: string): Promise<WllamaModule> {
  if (!isExtensionAssetUrl(url, browser.runtime.getURL(''))) {
    throw new Error(`Refusing to load a wllama bundle outside the extension: ${url}`);
  }
  const loaded: unknown = await import(/* @vite-ignore */ url);
  if (!isWllamaModule(loaded)) {
    throw new Error(`The wllama bundle at ${url} does not export Wllama.`);
  }
  return loaded;
}
