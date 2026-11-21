import { assetBundleSize, type AssetFile, type AssetPin } from '@/engine/model/asset';

export type OcrModelId = 'tiny_det' | 'small_det' | 'medium_det' | 'small_rec' | 'medium_rec';
export type OcrModelRole = 'det' | 'rec';
export type OcrTier = 'standard' | 'high';

export interface OcrModelEntry extends AssetPin {
  id: OcrModelId;
  role: OcrModelRole;
  repository: `PaddlePaddle/${string}`;
  file: 'inference.onnx';
}

export interface OcrTierEntry {
  id: OcrTier;
  size: number;
  det: OcrModelEntry;
  rec: OcrModelEntry;
  files: readonly AssetFile[];
}

export interface OcrModelWithRole extends OcrModelEntry {
  role: OcrModelRole;
}

const HUGGING_FACE = 'https://huggingface.co';

function model(
  id: OcrModelId,
  role: OcrModelRole,
  commit: string,
  size: number,
  sha256: string,
): OcrModelEntry {
  const repository = `PaddlePaddle/PP-OCRv6_${id}_onnx` as const;
  return {
    id,
    role,
    repository,
    file: 'inference.onnx',
    commit,
    size,
    sha256,
    url: `${HUGGING_FACE}/${repository}/resolve/${commit}/inference.onnx`,
  };
}

// PaddleOCR 3.7.0 PP-OCRv6 ONNX. Every digest was computed from the downloaded
// inference.onnx and agrees with Hugging Face's LFS metadata at the pinned commit.
export const OCR_MODEL_CATALOG: Readonly<Record<OcrModelId, OcrModelEntry>> = Object.freeze({
  tiny_det: model(
    'tiny_det',
    'det',
    '2ba1506c0380b8f0b03dd142459aac66d4421f6c',
    1_780_590,
    '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8',
  ),
  small_det: model(
    'small_det',
    'det',
    '28fe5895c24fd108c19eb3e8479f4ab385fbfc62',
    9_880_512,
    'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e',
  ),
  medium_det: model(
    'medium_det',
    'det',
    '61323801669c338b7891481ec7bac61ce31b576a',
    62_032_837,
    'eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1',
  ),
  small_rec: model(
    'small_rec',
    'rec',
    'b8f84f0b80c529de40b4fbb3544b84fa7233a513',
    21_159_378,
    '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634',
  ),
  medium_rec: model(
    'medium_rec',
    'rec',
    '50c7eacafc52fa7bcf4194e8cd08e46f8558504b',
    76_554_979,
    '9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba',
  ),
});

function tier(id: OcrTier, det: OcrModelEntry, rec: OcrModelEntry): OcrTierEntry {
  const files = [det, rec].map((entry) => ({ ...entry, path: `${entry.id}.onnx` }));
  return { id, det, rec, files, size: assetBundleSize(files) };
}

// Standard was selected on the generated CC0 eight-case Node/WASM benchmark: 0.3% micro-CER
// and 769 ms/page versus 3.1%/1083 ms (small+small) and 10.3%/5836 ms (medium+medium).
// See bench/results/ocr-benchmark.md. The high tier remains medium detection plus recognition
// for difficult real-world scans where its extra compute may help; generated fixtures alone
// do not establish broad accuracy superiority.
export const OCR_TIER_CATALOG: Readonly<Record<OcrTier, OcrTierEntry>> = Object.freeze({
  standard: tier('standard', OCR_MODEL_CATALOG.tiny_det, OCR_MODEL_CATALOG.small_rec),
  high: tier('high', OCR_MODEL_CATALOG.medium_det, OCR_MODEL_CATALOG.medium_rec),
});

export const DEFAULT_OCR_TIER: OcrTier = 'standard';
export const SELECTABLE_OCR_TIERS: readonly OcrTier[] = ['standard', 'high'];
const OCR_TIERS: ReadonlySet<string> = new Set(SELECTABLE_OCR_TIERS);

export function isOcrTier(value: unknown): value is OcrTier {
  return typeof value === 'string' && OCR_TIERS.has(value);
}

export function getOcrTier(tier: OcrTier): OcrTierEntry {
  return OCR_TIER_CATALOG[tier];
}

/** Release dictionary plus CTC blank at 0 and an appended ASCII space at 18,709. */
export const OCR_CHARSET = Object.freeze({
  path: 'ocr/pp-ocrv6-chars.txt',
  entries: 18_708,
  classes: 18_710,
  size: 74_947,
  sha256: 'b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d',
});
