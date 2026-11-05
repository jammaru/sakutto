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
  commit: '03891e907db8a43c97d3a7c75add125cc6d1f96a',
  size: 573_116_288,
  sha256: '3dbb09295bfd3350231ba0dba92bc72cb14111ef1b034e37dad39d581bd86b9c',
  url: resolveUrl(
    'pfnet/plamo-3-translate-0.8b-GGUF',
    '03891e907db8a43c97d3a7c75add125cc6d1f96a',
    'plamo-3-translate-0.8b-Q4_K_M.gguf',
  ),
};

const TWO: ModelEntry = {
  id: 'plamo-3-translate-2b-q4_k_m',
  params: '2B',
  quantization: 'Q4_K_M',
  repository: 'pfnet/plamo-3-translate-2b-GGUF',
  file: 'plamo-3-translate-2b-Q4_K_M.gguf',
  commit: 'f2b4599dff9b3e45c62567eac15e83186b4cb64e',
  size: 1_807_192_480,
  sha256: '2c288ecc7ebfe60c3561726580da3583767f3c41ca3ef5c6825bf6c4cc060787',
  url: resolveUrl(
    'pfnet/plamo-3-translate-2b-GGUF',
    'f2b4599dff9b3e45c62567eac15e83186b4cb64e',
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
