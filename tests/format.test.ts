import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID, HIGH_QUALITY_MODEL_ID, getModel } from '@/engine/model/catalog';
import { formatByteSize, formatByteSizeList } from '@/ui/format';

describe('byte size labels', () => {
  it('names the catalog files in megabytes or gigabytes', () => {
    expect(formatByteSize(getModel(DEFAULT_MODEL_ID).size)).toBe('573 MB');
    expect(formatByteSize(getModel(HIGH_QUALITY_MODEL_ID).size)).toBe('1.81 GB');
    expect(formatByteSizeList([getModel(DEFAULT_MODEL_ID).size])).toBe('573 MB');
    expect(
      formatByteSizeList([getModel(DEFAULT_MODEL_ID).size, getModel(HIGH_QUALITY_MODEL_ID).size]),
    ).toBe('573 MB / 1.81 GB');
  });
});
