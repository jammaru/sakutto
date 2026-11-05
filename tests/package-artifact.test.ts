import { describe, expect, it } from 'vitest';
import { MIN_STORE_ZIP_BYTES, storeZipProblems } from '../scripts/package-artifact';

describe('store zip guard', () => {
  it('rejects a missing zip and the manifest-only artifact', () => {
    expect(storeZipProblems([])).toEqual(['the store zip is missing']);
    expect(storeZipProblems([{ name: 'wllama-build.json', bytes: 1145 }])).toEqual([
      'the store zip is missing',
    ]);
    expect(storeZipProblems([{ name: 'extension.zip', bytes: 1145 }])).toEqual([
      `extension.zip is 1145 bytes, below ${String(MIN_STORE_ZIP_BYTES)}`,
    ]);
  });

  it('accepts the store zip once it is large enough to hold the runtime', () => {
    expect(
      storeZipProblems([{ name: 'sakutto-0.1.0-chrome.zip', bytes: 7_500_000 }]),
    ).toEqual([]);
  });
});
