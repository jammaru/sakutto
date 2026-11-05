import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID } from '@/engine/model/catalog';
import type { ModelStatus } from '@/shared/engine-status';
import { advanceModelStatus } from '@/shared/model-progress';

function status(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: DEFAULT_MODEL_ID,
    state: 'downloading',
    received: 0,
    total: 100,
    progress: 0,
    ...overrides,
  };
}

describe('model progress', () => {
  it('does not let a later sample move the percent backwards', () => {
    const high = advanceModelStatus(null, status({ received: 73, progress: 0.73 }));
    const next = advanceModelStatus(high, status({ received: 59, progress: 0.59 }));

    expect(next.received).toBe(73);
    expect(next.progress).toBeCloseTo(0.73);
  });

  it('keeps a full bar while the downloaded file is checked', () => {
    const downloaded = advanceModelStatus(null, status({ received: 100, total: 100, progress: 1 }));
    const verifying = advanceModelStatus(
      downloaded,
      status({ state: 'verifying', received: 0, progress: 0 }),
    );

    expect(verifying.state).toBe('verifying');
    expect(verifying.progress).toBe(1);
    expect(verifying.received).toBe(100);
  });

  it('allows a download that starts again from an empty file', () => {
    const high = advanceModelStatus(null, status({ received: 40, progress: 0.4 }));
    const restart = advanceModelStatus(high, status({ received: 0, progress: 0 }));

    expect(restart.received).toBe(0);
    expect(restart.progress).toBe(0);
  });
});
