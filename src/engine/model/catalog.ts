export type ModelId = 'plamo-3-translate-0.8b-q4_k_m' | 'plamo-3-translate-2b-q4_k_m';

/** One officially published blob of a model file. */
export interface ModelRevision {
  commit: string;
  size: number;
  sha256: string;
}

export interface ModelEntry {
  id: ModelId;
  params: '0.8B' | '2B';
  quantization: 'Q4_K_M';
  repository: string;
  file: string;
  /** Revision used for new downloads. Always the first item of `revisions`. */
  commit: string;
  size: number;
  sha256: string;
  url: string;
  /** Every known official revision, including the one we download by default. */
  revisions: readonly ModelRevision[];
}

/**
 * The scalar pin fields plus the optional revision list. Verification helpers accept this
 * narrower shape so callers with a single-revision test fixture keep working unchanged.
 */
export type RevisionPin = Pick<ModelEntry, 'commit' | 'size' | 'sha256'> &
  Partial<Pick<ModelEntry, 'revisions'>>;

const HUGGING_FACE = 'https://huggingface.co';

function resolveUrl(repository: string, commit: string, file: string): string {
  return `${HUGGING_FACE}/${repository}/resolve/${commit}/${file}`;
}

/** The moving upstream URL used by the pin checker, never by the extension downloader. */
export function latestUrl(entry: Pick<ModelEntry, 'repository' | 'file'>): string {
  return resolveUrl(entry.repository, 'main', entry.file);
}

/** Known official revisions, falling back to the scalar pin for single-revision callers. */
export function knownRevisions(entry: RevisionPin): readonly ModelRevision[] {
  if (entry.revisions && entry.revisions.length > 0) return entry.revisions;
  return [{ commit: entry.commit, size: entry.size, sha256: entry.sha256 }];
}

export function revisionForSize(entry: RevisionPin, size: number): ModelRevision | undefined {
  return knownRevisions(entry).find((revision) => revision.size === size);
}

export function revisionForDigest(entry: RevisionPin, digest: string): ModelRevision | undefined {
  return knownRevisions(entry).find((revision) => revision.sha256 === digest);
}

function defineModel(
  model: Omit<ModelEntry, 'commit' | 'size' | 'sha256' | 'url'> & {
    revisions: readonly ModelRevision[];
  },
): ModelEntry {
  const revision = model.revisions[0];
  if (!revision) throw new Error(`No official revision for ${model.id}`);
  return {
    ...model,
    commit: revision.commit,
    size: revision.size,
    sha256: revision.sha256,
    url: resolveUrl(model.repository, revision.commit, model.file),
  };
}

const ZERO_EIGHT = defineModel({
  id: 'plamo-3-translate-0.8b-q4_k_m',
  params: '0.8B',
  quantization: 'Q4_K_M',
  repository: 'pfnet/plamo-3-translate-0.8b-GGUF',
  file: 'plamo-3-translate-0.8b-Q4_K_M.gguf',
  // The download default is listed first; the remaining revisions follow publish order.
  revisions: [
    {
      commit: 'dbeb0856cb0b004b484f190bb71dd65876297013',
      size: 573_123_200,
      sha256: '923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd',
    },
    {
      commit: '03891e907db8a43c97d3a7c75add125cc6d1f96a',
      size: 573_116_288,
      sha256: '3dbb09295bfd3350231ba0dba92bc72cb14111ef1b034e37dad39d581bd86b9c',
    },
    {
      commit: 'e11a613b483edceab3450941f18cc79307fc93e9',
      size: 573_125_696,
      sha256: 'ff10c4aed0c478af8be61fe4d22fb463c0f639acfc168012062efba35ccbdd48',
    },
    {
      commit: '0c4af2b003fdd94b6868aa955414c1c86ee96997',
      size: 573_125_952,
      sha256: '73a1d942d8ab1e654d83898d997b8b4808c32ba669b378df612230989d18f079',
    },
    {
      commit: 'e10c327b7a7ce84ffc427cb4b09360b781429fda',
      size: 573_126_848,
      sha256: '70891ec70dc7ab4205745a38307867c2881b99239f20327927633abfe4bc9ec6',
    },
    {
      commit: '7de4409f84a9d70e3a5e87b81e84883d49f77b58',
      size: 573_126_848,
      sha256: '70891ec70dc7ab4205745a38307867c2881b99239f20327927633abfe4bc9ec6',
    },
  ],
});

const TWO = defineModel({
  id: 'plamo-3-translate-2b-q4_k_m',
  params: '2B',
  quantization: 'Q4_K_M',
  repository: 'pfnet/plamo-3-translate-2b-GGUF',
  file: 'plamo-3-translate-2b-Q4_K_M.gguf',
  // The download default is listed first; the remaining distinct blobs follow publish order.
  revisions: [
    {
      commit: '232fbd7916519edecddfdae0beae7e76fe70453f',
      size: 1_807_199_392,
      sha256: 'f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0',
    },
    {
      commit: 'f2b4599dff9b3e45c62567eac15e83186b4cb64e',
      size: 1_807_192_480,
      sha256: '2c288ecc7ebfe60c3561726580da3583767f3c41ca3ef5c6825bf6c4cc060787',
    },
    {
      commit: '4e4500666915b3a2cc0d667b64d9745c0821b63c',
      size: 1_807_201_888,
      sha256: 'ac60fbb2e392349a6d3b53c7903655005377cf543703ad3869b31ab5d96a7ffb',
    },
    {
      commit: 'd44589ecd5287cd64452e9cd1e2cfdad904fe216',
      size: 1_807_202_144,
      sha256: '2189a8a0b4b359f59443ec36cfb9c9c3f603a678c00dbcee8598b3f7ea7c12fb',
    },
    {
      commit: 'caf0267797e8a4ae418e7d8c480746be2ea6040c',
      size: 1_807_203_040,
      sha256: '1ffd9073afcc70e35ccc942428aa2b73d7aa2b9ea779bf504b775369e0276c13',
    },
  ],
});

export const MODEL_CATALOG: Readonly<Record<ModelId, ModelEntry>> = Object.freeze({
  'plamo-3-translate-0.8b-q4_k_m': ZERO_EIGHT,
  'plamo-3-translate-2b-q4_k_m': TWO,
});

export const DEFAULT_MODEL_ID: ModelId = ZERO_EIGHT.id;

export const HIGH_QUALITY_MODEL_ID: ModelId = TWO.id;

export const SELECTABLE_MODEL_IDS: readonly ModelId[] = [ZERO_EIGHT.id, TWO.id];

const MODEL_IDS: ReadonlySet<string> = new Set<ModelId>(SELECTABLE_MODEL_IDS);

export function isModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && MODEL_IDS.has(value);
}

export function getModel(modelId: ModelId): ModelEntry {
  return MODEL_CATALOG[modelId];
}
