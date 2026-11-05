import { isModelId, type ModelId } from '../engine/model/catalog';
import type { BackendKind, ComputeTier } from '../engine/in-browser/backend';
import type { EngineKind } from '../engine/types';

export type ModelState =
  'absent' | 'partial' | 'downloading' | 'verifying' | 'ready' | 'loading' | 'loaded' | 'error';

export interface ModelStatus {
  id: ModelId;
  state: ModelState;
  received: number;
  total: number;
  progress: number;
  error?: string;
}

export interface EngineStatus {
  model: ModelStatus;
  backend: BackendKind | null;
  tier: ComputeTier | null;
  threads: number | null;
  parallel: number | null;
  plamoReady: boolean;
  chromeSupported: boolean;
  active: EngineKind | null;
}

const MODEL_STATES: ReadonlySet<string> = new Set<ModelState>([
  'absent',
  'partial',
  'downloading',
  'verifying',
  'ready',
  'loading',
  'loaded',
  'error',
]);

const BACKENDS: ReadonlySet<string> = new Set<BackendKind>(['webgpu', 'cpu-wasm']);
const TIERS: ReadonlySet<string> = new Set<ComputeTier>(['g', 'c8', 'c4']);
const ENGINES: ReadonlySet<string> = new Set<EngineKind>(['plamo', 'chrome']);

export function isModelStatus(value: unknown): value is ModelStatus {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!isModelId(record.id)) return false;
  if (typeof record.state !== 'string' || !MODEL_STATES.has(record.state)) return false;
  if (typeof record.received !== 'number' || typeof record.total !== 'number') return false;
  if (typeof record.progress !== 'number') return false;
  if (record.error !== undefined && typeof record.error !== 'string') return false;
  return true;
}

export function isEngineStatus(value: unknown): value is EngineStatus {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!isModelStatus(record.model)) return false;
  if (
    record.backend !== null &&
    (typeof record.backend !== 'string' || !BACKENDS.has(record.backend))
  ) {
    return false;
  }
  if (record.tier !== null && (typeof record.tier !== 'string' || !TIERS.has(record.tier))) {
    return false;
  }
  if (record.threads !== null && typeof record.threads !== 'number') return false;
  if (record.parallel !== null && typeof record.parallel !== 'number') return false;
  if (typeof record.plamoReady !== 'boolean') return false;
  if (typeof record.chromeSupported !== 'boolean') return false;
  if (
    record.active !== null &&
    (typeof record.active !== 'string' || !ENGINES.has(record.active))
  ) {
    return false;
  }
  return true;
}
