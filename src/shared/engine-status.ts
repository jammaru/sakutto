import { isModelId, type ModelId } from '../engine/model/catalog';
import type { BackendKind, ComputeTier } from '../engine/in-browser/backend';
import type { EngineKind } from '../engine/types';
import { FOLDER_PERMISSION_ERROR } from '../engine/model/folder-permission';
import {
  isSharedFolderStatus,
  sharedFolderNeedsPermission,
  type SharedFolderStatus,
} from '../engine/model/folder-status';
import { isGpuDiagnostic, type GpuDiagnostic } from './gpu-diagnostic';

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

export type EngineSource = 'in-browser' | 'local-server';

/** Which WebGPU step ended on the CPU, so the status label can name it. */
export type GpuFallbackReason = 'load' | 'output' | 'device' | 'adapter';

export interface EngineStatus {
  model: ModelStatus;
  backend: BackendKind | null;
  tier: ComputeTier | null;
  threads: number | null;
  parallel: number | null;
  /** WebGPU was offered but the model could not be placed on it, so it runs on the CPU. */
  gpuFallback?: boolean;
  /** Missing means an older host; treat it as a model-load fallback. */
  gpuFallbackReason?: GpuFallbackReason;
  /** Adapter features/limits and the llama.cpp error, if WebGPU failed. Stays on the device. */
  gpuDiagnostic?: GpuDiagnostic;
  plamoReady: boolean;
  chromeSupported: boolean;
  active: EngineKind | null;
  /** True when the stored model was missing and another installed model is in use. */
  modelFallback?: boolean;
  /** Where PLaMo requests are sent. Missing means the built-in engine. */
  engineSource?: EngineSource;
  /** Chromium-only opt-in shared model folder. Missing on Firefox and older hosts. */
  sharedFolder?: SharedFolderStatus;
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

const BACKENDS: ReadonlySet<string> = new Set<BackendKind>(['webgpu', 'cpu-wasm', 'local-server']);
const ENGINE_SOURCES: ReadonlySet<string> = new Set<EngineSource>(['in-browser', 'local-server']);
const TIERS: ReadonlySet<string> = new Set<ComputeTier>(['g', 'c8', 'c4', 'c1']);
const ENGINES: ReadonlySet<string> = new Set<EngineKind>(['plamo', 'chrome']);
const GPU_FALLBACK_REASONS: ReadonlySet<string> = new Set<GpuFallbackReason>([
  'load',
  'output',
  'device',
  'adapter',
]);

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

/**
 * True when a control that starts a PLaMo translation should stay disabled. A local server
 * does not need the GGUF file on disk; the request fails later if that server is down.
 */
export function translationStartBlocked(
  status: Pick<EngineStatus, 'model' | 'engineSource'> | null | undefined,
): boolean {
  if (!status) return false;
  if (status.engineSource === 'local-server') return false;
  return modelStartBlocked(status.model);
}

/**
 * The popup/onboarding "model is still downloading" gate. A missing folder grant is
 * not a missing file: that state has its own restore card, so this gate stays hidden.
 */
export function shouldShowModelDownloadGate(
  status: Pick<EngineStatus, 'model' | 'engineSource' | 'sharedFolder'> | null | undefined,
): boolean {
  if (sharedFolderNeedsPermission(status?.sharedFolder)) return false;
  return translationStartBlocked(status);
}

interface ModelDownloadStatus {
  model: Pick<ModelStatus, 'state' | 'error'>;
  engineSource?: EngineSource | undefined;
  sharedFolder?: SharedFolderStatus | undefined;
}

/**
 * True only when the missing folder grant needs the reader to act. A verified OPFS copy or an
 * already-ready model can answer the load, so the page must not show a folder toast in that
 * case. This mirrors `sharedFolderAllowsModelLoad` without needing the offscreen manager.
 *
 * A local server never reads the model folder, so no grant state of that folder can block
 * its pages — the same rule `translationStartBlocked` applies to start controls.
 */
export function sharedFolderNeedsUserAction(
  status: Pick<EngineStatus, 'model' | 'sharedFolder' | 'engineSource'> | null | undefined,
): boolean {
  if (status?.engineSource === 'local-server') return false;
  const folder = status?.sharedFolder;
  if (!sharedFolderNeedsPermission(folder)) return false;
  const model = status?.model;
  if (!model) return true;
  if (modelCanTranslate(model)) return false;
  if (model.state === 'loading' || model.state === 'downloading' || model.state === 'verifying') {
    return false;
  }
  return folder?.opfsCopies.includes(model.id) !== true;
}

/**
 * The model file is genuinely absent, so the popup should offer a concrete way to get it
 * (download, import, or choose a folder) rather than a generic "waiting" label. A pending
 * download, a load, or a folder that only needs permission is not this state.
 */
export function modelNeedsDownload(status: ModelDownloadStatus | null | undefined): boolean {
  if (!status || status.engineSource === 'local-server') return false;
  if (sharedFolderNeedsPermission(status.sharedFolder)) return false;
  if (status.model.error === FOLDER_PERMISSION_ERROR) return false;
  const state = status.model.state;
  return state === 'absent' || state === 'partial';
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
  if (
    record.gpuFallbackReason !== undefined &&
    (typeof record.gpuFallbackReason !== 'string' ||
      !GPU_FALLBACK_REASONS.has(record.gpuFallbackReason))
  ) {
    return false;
  }
  if (record.gpuDiagnostic !== undefined && !isGpuDiagnostic(record.gpuDiagnostic)) return false;
  if (typeof record.plamoReady !== 'boolean') return false;
  if (typeof record.chromeSupported !== 'boolean') return false;
  if (
    record.active !== null &&
    (typeof record.active !== 'string' || !ENGINES.has(record.active))
  ) {
    return false;
  }
  if (record.modelFallback !== undefined && typeof record.modelFallback !== 'boolean') return false;
  if (
    record.engineSource !== undefined &&
    (typeof record.engineSource !== 'string' || !ENGINE_SOURCES.has(record.engineSource))
  ) {
    return false;
  }
  if (record.sharedFolder !== undefined && !isSharedFolderStatus(record.sharedFolder)) {
    return false;
  }
  return true;
}
