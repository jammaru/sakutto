import { type ModelStatus } from '@/shared/engine-status';
import { DEFAULT_MODEL_ID, isModelId, type ModelId } from './catalog';

export function normalizeSelectedModelId(value: unknown): ModelId {
  return isModelId(value) ? value : DEFAULT_MODEL_ID;
}

/**
 * The file is on the device, or a download/load of it is already running. `absent` is the
 * only state that means "not here"; a lone status check before OPFS is open can also look
 * like that, so callers should not treat a missing status object as a confirmed gap.
 */
export function isModelFilePresent(state: ModelStatus['state']): boolean {
  return (
    state === 'ready' ||
    state === 'loaded' ||
    state === 'loading' ||
    state === 'partial' ||
    state === 'downloading' ||
    state === 'verifying'
  );
}

/**
 * Picks the model the engine should use. A stored preference wins while it is present or
 * only transiently unchecked. When that file is confirmed absent, the first installed model
 * is used instead of silently pointing at a missing default.
 */
export function resolveActiveModel(
  preferred: ModelId,
  statuses: readonly Pick<ModelStatus, 'id' | 'state'>[],
): { modelId: ModelId; fallback: boolean } {
  const preferredStatus = statuses.find((status) => status.id === preferred);
  if (!preferredStatus) return { modelId: preferred, fallback: false };
  if (preferredStatus.state !== 'absent') return { modelId: preferred, fallback: false };

  const installed = statuses.find(
    (status) => status.id !== preferred && isModelFilePresent(status.state),
  );
  if (installed) return { modelId: installed.id, fallback: true };
  return { modelId: preferred, fallback: false };
}
