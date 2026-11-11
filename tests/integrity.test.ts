import { describe, expect, it } from 'vitest';
import { decideIntegrity, digestMatchesPin } from '@/engine/model/integrity';

const ENTRY = {
  sha256: 'abc',
  size: 12,
  commit: 'c1',
};

describe('decideIntegrity', () => {
  it('treats a missing or empty file as missing', () => {
    expect(decideIntegrity(ENTRY, null, null)).toBe('missing');
    expect(decideIntegrity(ENTRY, { size: 0, lastModified: 1 }, null)).toBe('missing');
  });

  it('rejects a size that is not the catalog pin', () => {
    expect(decideIntegrity(ENTRY, { size: 11, lastModified: 1 }, null)).toBe('reject-size');
    expect(
      decideIntegrity(ENTRY, { size: 11, lastModified: 1 }, { ...ENTRY, lastModified: 1 }),
    ).toBe('reject-size');
  });

  it('requires a hash when there is no sidecar, or the pin changed', () => {
    expect(decideIntegrity(ENTRY, { size: 12, lastModified: 5 }, null)).toBe('needs-hash');
    expect(
      decideIntegrity(ENTRY, { size: 12, lastModified: 5 }, { ...ENTRY, sha256: 'other' }),
    ).toBe('needs-hash');
    expect(decideIntegrity(ENTRY, { size: 12, lastModified: 5 }, { ...ENTRY, commit: 'c2' })).toBe(
      'needs-hash',
    );
  });

  it('trusts a matching sidecar, including a legacy one without lastModified', () => {
    expect(decideIntegrity(ENTRY, { size: 12, lastModified: 5 }, ENTRY)).toBe('verified');
    expect(
      decideIntegrity(ENTRY, { size: 12, lastModified: 5 }, { ...ENTRY, lastModified: 5 }),
    ).toBe('verified');
  });

  it('rehashes when lastModified changes', () => {
    expect(
      decideIntegrity(ENTRY, { size: 12, lastModified: 9 }, { ...ENTRY, lastModified: 5 }),
    ).toBe('needs-hash');
  });
});

describe('digestMatchesPin', () => {
  it('accepts only the pinned digest', () => {
    expect(digestMatchesPin('abc', ENTRY)).toBe(true);
    expect(digestMatchesPin('nope', ENTRY)).toBe(false);
  });
});
