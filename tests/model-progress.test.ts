import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID } from '@/engine/model/catalog';
import type { ModelStatus } from '@/shared/engine-status';
import {
  advanceModelStatus,
  modelRemovalOutcome,
  modelRemovalStopsTranslation,
} from '@/shared/model-progress';

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

describe('model removal recovery', () => {
  it('distinguishes no usable model from a fallback that can translate', () => {
    expect(modelRemovalOutcome(status(), status({ state: 'absent' }))).toBe('missing');
    expect(modelRemovalOutcome(status(), null)).toBe('missing');
    expect(
      modelRemovalOutcome(status(), status({ id: 'plamo-3-translate-2b-q4_k_m', state: 'ready' })),
    ).toBe('recovered');
    expect(
      modelRemovalOutcome(status(), status({ id: 'plamo-3-translate-2b-q4_k_m', state: 'loaded' })),
    ).toBe('recovered');
    expect(
      modelRemovalOutcome(
        status(),
        status({ id: 'plamo-3-translate-2b-q4_k_m', state: 'downloading' }),
      ),
    ).toBe('missing');
  });

  it('stops an in-browser page but never a local-server page', () => {
    // The in-browser engine just lost the file it was reading, so its pages stop and
    // show the missing-model notice.
    expect(modelRemovalStopsTranslation('in-browser')).toBe(true);
    // An older host that did not report an engine source is treated as in-browser.
    expect(modelRemovalStopsTranslation(undefined)).toBe(true);
    // A local server never reads the GGUF file, so deleting every in-browser model
    // leaves its pages translating.
    expect(modelRemovalStopsTranslation('local-server')).toBe(false);
  });
});

describe('model progress', () => {
  it('does not let a later sample move the percent backwards', () => {
    const high = advanceModelStatus(null, status({ received: 73, progress: 0.73 }));
    const next = advanceModelStatus(high, status({ received: 59, progress: 0.59 }));

    expect(next.received).toBe(73);
    expect(next.progress).toBeCloseTo(0.73);
  });

  it('never moves the byte count backwards while the file is checked', () => {
    const resumed = advanceModelStatus(null, status({ received: 75, total: 100, progress: 0.75 }));
    const prefix = advanceModelStatus(
      resumed,
      status({ state: 'verifying', received: 16, total: 100, progress: 0.16 }),
    );

    expect(prefix.state).toBe('verifying');
    expect(prefix.progress).toBeCloseTo(0.75);
    expect(prefix.received).toBe(75);

    const finished = advanceModelStatus(
      prefix,
      status({ state: 'verifying', received: 100, total: 100, progress: 1 }),
    );
    expect(finished.progress).toBe(1);
    expect(finished.received).toBe(100);
  });

  it('does not flip from verifying back to downloading', () => {
    const verifying = advanceModelStatus(
      null,
      status({ state: 'verifying', received: 75, total: 100, progress: 0.75 }),
    );
    const moreDownload = advanceModelStatus(
      verifying,
      status({ state: 'downloading', received: 80, total: 100, progress: 0.8 }),
    );

    expect(moreDownload.state).toBe('verifying');
    expect(moreDownload.received).toBe(80);
    expect(moreDownload.progress).toBeCloseTo(0.8);
  });

  it('keeps the full bar once the file is on disk and loading', () => {
    const downloaded = advanceModelStatus(null, status({ received: 100, total: 100, progress: 1 }));
    const loading = advanceModelStatus(
      downloaded,
      status({ state: 'loading', received: 0, progress: 0 }),
    );

    expect(loading.state).toBe('loading');
    expect(loading.progress).toBe(1);
    expect(loading.received).toBe(100);
  });

  it('allows a download that starts again from an empty file', () => {
    const high = advanceModelStatus(null, status({ received: 40, progress: 0.4 }));
    const restart = advanceModelStatus(high, status({ received: 0, progress: 0 }));

    expect(restart.received).toBe(0);
    expect(restart.progress).toBe(0);
  });
});
