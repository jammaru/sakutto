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
  /** WebGPU was offered but the model could not be placed on it, so it runs on the CPU. */
  gpuFallback?: boolean;
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

/**
 * True when a translation request can be served right now. `ready` is a verified file on
 * disk: the first request loads it, so a reader may start.
 */
export function modelCanTranslate(status: Pick<ModelStatus, 'state'> | null | undefined): boolean {
  return status?.state === 'ready' || status?.state === 'loaded';
}

/**
 * True when a start-now control has to stay out of the way because the model cannot answer
 * yet: no file, a file still downloading or being verified, or a load that failed. `loading`
 * is not blocked — a request joins the load that is already running.
 *
 * A control that starts a translation anyway leaves the reader in front of a page that keeps
 * its source text, which reads as a broken translation rather than as a download in progress.
 */
export function modelStartBlocked(status: Pick<ModelStatus, 'state'> | null | undefined): boolean {
  const state = status?.state;
  if (state === undefined) return false;
  return state !== 'ready' && state !== 'loaded' && state !== 'loading';
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
  if (record.gpuFallback !== undefined && typeof record.gpuFallback !== 'boolean') return false;
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
