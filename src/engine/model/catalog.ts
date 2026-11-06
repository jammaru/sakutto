export type ModelId = 'plamo-3-translate-0.8b-q4_k_m' | 'plamo-3-translate-2b-q4_k_m';

export interface ModelEntry {
  id: ModelId;
  params: '0.8B' | '2B';
  quantization: 'Q4_K_M';
  repository: string;
  file: string;
  commit: string;
  size: number;
  sha256: string;
  url: string;
}

const HUGGING_FACE = 'https://huggingface.co';

function resolveUrl(repository: string, commit: string, file: string): string {
  return `${HUGGING_FACE}/${repository}/resolve/${commit}/${file}`;
}

const ZERO_EIGHT: ModelEntry = {
  id: 'plamo-3-translate-0.8b-q4_k_m',
  params: '0.8B',
  quantization: 'Q4_K_M',
  repository: 'pfnet/plamo-3-translate-0.8b-GGUF',
  file: 'plamo-3-translate-0.8b-Q4_K_M.gguf',
  commit: 'dbeb0856cb0b004b484f190bb71dd65876297013',
  size: 573_123_200,
  sha256: '923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd',
  url: resolveUrl(
    'pfnet/plamo-3-translate-0.8b-GGUF',
    'dbeb0856cb0b004b484f190bb71dd65876297013',
    'plamo-3-translate-0.8b-Q4_K_M.gguf',
  ),
};

const TWO: ModelEntry = {
  id: 'plamo-3-translate-2b-q4_k_m',
  params: '2B',
  quantization: 'Q4_K_M',
  repository: 'pfnet/plamo-3-translate-2b-GGUF',
  file: 'plamo-3-translate-2b-Q4_K_M.gguf',
  commit: '232fbd7916519edecddfdae0beae7e76fe70453f',
  size: 1_807_199_392,
  sha256: 'f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0',
  url: resolveUrl(
    'pfnet/plamo-3-translate-2b-GGUF',
    '232fbd7916519edecddfdae0beae7e76fe70453f',
    'plamo-3-translate-2b-Q4_K_M.gguf',
  ),
};

export const MODEL_CATALOG: Readonly<Record<ModelId, ModelEntry>> = Object.freeze({
  'plamo-3-translate-0.8b-q4_k_m': ZERO_EIGHT,
  'plamo-3-translate-2b-q4_k_m': TWO,
});

export const DEFAULT_MODEL_ID: ModelId = ZERO_EIGHT.id;

export const HIGH_QUALITY_MODEL_ID: ModelId = TWO.id;

const MODEL_IDS: ReadonlySet<string> = new Set<ModelId>([ZERO_EIGHT.id, TWO.id]);

export function isModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && MODEL_IDS.has(value);
}

export function getModel(modelId: ModelId): ModelEntry {
  return MODEL_CATALOG[modelId];
}
