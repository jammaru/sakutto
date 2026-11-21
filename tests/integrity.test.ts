import { describe, expect, it } from 'vitest';
import { getModel } from '@/engine/model/catalog';
import { decideIntegrity, digestMatchesPin } from '@/engine/model/integrity';

const ENTRY = {
  sha256: 'abc',
  size: 12,
  commit: 'c1',
};

const MULTI = {
  ...ENTRY,
  revisions: [
    { commit: 'c1', size: 12, sha256: 'abc' },
    { commit: 'c2', size: 14, sha256: 'def' },
    { commit: 'c3', size: 16, sha256: 'ghi' },
  ],
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

  it('accepts a verified manifest for any known revision', () => {
    for (const revision of MULTI.revisions) {
      const file = { size: revision.size, lastModified: 7 };
      const manifest = { ...revision, lastModified: 7 };
      expect(decideIntegrity(MULTI, file, manifest)).toBe('verified');
      expect(decideIntegrity(MULTI, file, { ...manifest, lastModified: 8 })).toBe('needs-hash');
    }
  });

  it('rejects sizes outside every known revision without hashing', () => {
    for (const size of [11, 13, 15, 17]) {
      expect(decideIntegrity(MULTI, { size, lastModified: 7 }, null)).toBe('reject-size');
      const first = MULTI.revisions[0];
      expect(
        decideIntegrity(
          MULTI,
          { size, lastModified: 7 },
          {
            sha256: first?.sha256 ?? '',
            size: first?.size ?? 0,
            commit: first?.commit ?? '',
            lastModified: 7,
          },
        ),
      ).toBe('reject-size');
    }
  });

  it('does not trust a sidecar that belongs to another revision', () => {
    const other = MULTI.revisions[2];
    expect(
      decideIntegrity(
        MULTI,
        { size: 12, lastModified: 7 },
        {
          sha256: other?.sha256 ?? '',
          size: other?.size ?? 0,
          commit: other?.commit ?? '',
          lastModified: 7,
        },
      ),
    ).toBe('needs-hash');
  });

  it('accepts old manifests for the 0.8B catalog entry', () => {
    const entry = getModel('plamo-3-translate-0.8b-q4_k_m');
    for (const revision of entry.revisions) {
      expect(
        decideIntegrity(
          entry,
          { size: revision.size, lastModified: 3 },
          { ...revision, lastModified: 3 },
        ),
      ).toBe('verified');
    }
  });
});

describe('digestMatchesPin', () => {
  it('accepts only the pinned digest', () => {
    expect(digestMatchesPin('abc', ENTRY)).toBe(true);
    expect(digestMatchesPin('nope', ENTRY)).toBe(false);
  });

  it('accepts any known official revision but no unknown hash', () => {
    for (const revision of MULTI.revisions) {
      expect(digestMatchesPin(revision.sha256, MULTI)).toBe(true);
    }
    expect(digestMatchesPin('unknown', MULTI)).toBe(false);
    const catalog = getModel('plamo-3-translate-0.8b-q4_k_m');
    expect(digestMatchesPin(catalog.revisions[2]?.sha256 ?? '', catalog)).toBe(true);
    expect(digestMatchesPin('0'.repeat(64), catalog)).toBe(false);
  });
});
