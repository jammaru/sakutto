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

describe('0.8B catalog known revisions', () => {
  const EXPECTED = [
    {
      commit: 'dbeb0856cb0b004b484f190bb71dd65876297013',
      size: 573_123_200,
      sha256: '923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd',
    },
    {
      commit: '03891e907db8a43c97d3a7c75add125cc6d1f96a',
      size: 573_116_288,
      sha256: '3dbb09295bfd3350231ba0dba92bc72cb14111ef1b034e37dad39d581bd86b9c',
    },
    {
      commit: 'e11a613b483edceab3450941f18cc79307fc93e9',
      size: 573_125_696,
      sha256: 'ff10c4aed0c478af8be61fe4d22fb463c0f639acfc168012062efba35ccbdd48',
    },
    {
      commit: '0c4af2b003fdd94b6868aa955414c1c86ee96997',
      size: 573_125_952,
      sha256: '73a1d942d8ab1e654d83898d997b8b4808c32ba669b378df612230989d18f079',
    },
    {
      commit: 'e10c327b7a7ce84ffc427cb4b09360b781429fda',
      size: 573_126_848,
      sha256: '70891ec70dc7ab4205745a38307867c2881b99239f20327927633abfe4bc9ec6',
    },
    {
      commit: '7de4409f84a9d70e3a5e87b81e84883d49f77b58',
      size: 573_126_848,
      sha256: '70891ec70dc7ab4205745a38307867c2881b99239f20327927633abfe4bc9ec6',
    },
  ];

  it('contains every verified official revision with the original download pin first', () => {
    const entry = getModel('plamo-3-translate-0.8b-q4_k_m');
    expect(entry.revisions).toEqual(EXPECTED);
    expect(entry.commit).toBe(EXPECTED[0]?.commit);
    expect(entry.size).toBe(EXPECTED[0]?.size);
    expect(entry.sha256).toBe(EXPECTED[0]?.sha256);
    expect(entry.url).toContain(`/resolve/${EXPECTED[0]?.commit}/`);
    expect(new Set(entry.revisions.map((item) => item.size)).size).toBe(5);
    expect(new Set(entry.revisions.map((item) => item.sha256)).size).toBe(5);
  });

  it('accepts a manifest and digest for every catalog row', () => {
    const entry = getModel('plamo-3-translate-0.8b-q4_k_m');
    for (const revision of entry.revisions) {
      expect(
        decideIntegrity(
          entry,
          { size: revision.size, lastModified: 11 },
          { ...revision, lastModified: 11 },
        ),
      ).toBe('verified');
      expect(digestMatchesPin(revision.sha256, entry)).toBe(true);
    }
  });

  it('fast-rejects sizes outside every catalog row', () => {
    const entry = getModel('plamo-3-translate-0.8b-q4_k_m');
    const known = new Set(entry.revisions.map((item) => item.size));
    for (const size of known) {
      for (const candidate of [size - 1, size + 1]) {
        expect(decideIntegrity(entry, { size: candidate, lastModified: 11 }, null)).toBe(
          'reject-size',
        );
      }
    }
  });
});
