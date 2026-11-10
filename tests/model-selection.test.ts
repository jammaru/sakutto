import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID, HIGH_QUALITY_MODEL_ID } from '@/engine/model/catalog';
import { normalizeSelectedModelId, resolveActiveModel } from '@/engine/model/selection';
import type { ModelStatus } from '@/shared/engine-status';

function status(
  id: ModelStatus['id'],
  state: ModelStatus['state'],
): Pick<ModelStatus, 'id' | 'state'> {
  return { id, state };
}

describe('selected model persistence', () => {
  it('keeps a stored high-accuracy model when it is on the device', () => {
    expect(
      resolveActiveModel(HIGH_QUALITY_MODEL_ID, [
        status(DEFAULT_MODEL_ID, 'absent'),
        status(HIGH_QUALITY_MODEL_ID, 'ready'),
      ]),
    ).toEqual({ modelId: HIGH_QUALITY_MODEL_ID, fallback: false });
  });

  it('does not fall back to the missing standard model after a restart', () => {
    expect(normalizeSelectedModelId(HIGH_QUALITY_MODEL_ID)).toBe(HIGH_QUALITY_MODEL_ID);
    expect(
      resolveActiveModel(normalizeSelectedModelId(HIGH_QUALITY_MODEL_ID), [
        status(DEFAULT_MODEL_ID, 'absent'),
        status(HIGH_QUALITY_MODEL_ID, 'ready'),
      ]).modelId,
    ).toBe(HIGH_QUALITY_MODEL_ID);
  });

  it('keeps the stored model when a status check has not finished', () => {
    expect(resolveActiveModel(HIGH_QUALITY_MODEL_ID, [])).toEqual({
      modelId: HIGH_QUALITY_MODEL_ID,
      fallback: false,
    });
  });

  it('keeps the stored model while it is only loading or still downloading', () => {
    expect(
      resolveActiveModel(HIGH_QUALITY_MODEL_ID, [
        status(DEFAULT_MODEL_ID, 'ready'),
        status(HIGH_QUALITY_MODEL_ID, 'loading'),
      ]).modelId,
    ).toBe(HIGH_QUALITY_MODEL_ID);
    expect(
      resolveActiveModel(HIGH_QUALITY_MODEL_ID, [status(HIGH_QUALITY_MODEL_ID, 'downloading')])
        .modelId,
    ).toBe(HIGH_QUALITY_MODEL_ID);
  });

  it('falls back to an installed model when the selection is confirmed absent', () => {
    expect(
      resolveActiveModel(DEFAULT_MODEL_ID, [
        status(DEFAULT_MODEL_ID, 'absent'),
        status(HIGH_QUALITY_MODEL_ID, 'ready'),
      ]),
    ).toEqual({ modelId: HIGH_QUALITY_MODEL_ID, fallback: true });
  });

  it('does not silently point at a missing default when nothing is installed', () => {
    expect(
      resolveActiveModel(HIGH_QUALITY_MODEL_ID, [
        status(DEFAULT_MODEL_ID, 'absent'),
        status(HIGH_QUALITY_MODEL_ID, 'absent'),
      ]),
    ).toEqual({ modelId: HIGH_QUALITY_MODEL_ID, fallback: false });
  });

  it('repairs an unknown stored id to the default model id', () => {
    expect(normalizeSelectedModelId(undefined)).toBe(DEFAULT_MODEL_ID);
    expect(normalizeSelectedModelId('nope')).toBe(DEFAULT_MODEL_ID);
  });
});
