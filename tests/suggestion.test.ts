import { describe, expect, it } from 'vitest';
import { getModel, HIGH_QUALITY_MODEL_ID } from '@/engine/model/catalog';
import {
  QUALITY_PARAGRAPH,
  shouldHintBuiltInFallback,
  shouldSuggestHighQuality,
  type HighQualityInput,
} from '@/engine/model/suggestion';

const MODEL_BYTES = getModel(HIGH_QUALITY_MODEL_ID).size;

function ready(overrides: Partial<HighQualityInput> = {}): HighQualityInput {
  return {
    tier: 'g',
    paragraphMs: 400,
    deviceMemoryGb: 8,
    freeStorageBytes: 2_500_000_000,
    maxBufferSize: MODEL_BYTES,
    modelBytes: MODEL_BYTES,
    dismissed: false,
    usingHighQuality: false,
    ...overrides,
  };
}

describe('high quality suggestion', () => {
  it('uses a 77-word paragraph', () => {
    expect(QUALITY_PARAGRAPH.trim().split(/\s+/)).toHaveLength(77);
  });

  it('suggests 2B only when every condition holds', () => {
    expect(shouldSuggestHighQuality(ready())).toBe(true);
    expect(shouldSuggestHighQuality(ready({ tier: 'c8' }))).toBe(false);
    expect(shouldSuggestHighQuality(ready({ paragraphMs: 500 }))).toBe(false);
    expect(shouldSuggestHighQuality(ready({ paragraphMs: null }))).toBe(false);
    expect(shouldSuggestHighQuality(ready({ deviceMemoryGb: 4 }))).toBe(false);
    expect(shouldSuggestHighQuality(ready({ freeStorageBytes: 2_000_000_000 }))).toBe(false);
    expect(shouldSuggestHighQuality(ready({ maxBufferSize: MODEL_BYTES - 1 }))).toBe(false);
    expect(shouldSuggestHighQuality(ready({ dismissed: true }))).toBe(false);
    expect(shouldSuggestHighQuality(ready({ usingHighQuality: true }))).toBe(false);
  });

  it('mentions the built-in translator only when a 4-thread machine is far over budget', () => {
    expect(shouldHintBuiltInFallback('c4', 15_001)).toBe(true);
    expect(shouldHintBuiltInFallback('c4', 15_000)).toBe(false);
    expect(shouldHintBuiltInFallback('c8', 20_000)).toBe(false);
    expect(shouldHintBuiltInFallback('c4', null)).toBe(false);
  });
});
