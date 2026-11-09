import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareDirectories } from '../scripts/compare-extension-builds.ts';

describe('compareDirectories', () => {
  it('reports a missing file and a changed file', () => {
    const root = mkdtempSync(join(tmpdir(), 'sakutto-compare-'));
    const left = join(root, 'left');
    const right = join(root, 'right');
    mkdirSync(left);
    mkdirSync(right);
    writeFileSync(join(left, 'manifest.json'), '{"a":1}');
    writeFileSync(join(right, 'manifest.json'), '{"a":2}');
    writeFileSync(join(left, 'only-left.js'), 'left');
    try {
      expect(compareDirectories(left, right).sort()).toEqual([
        'differ: manifest.json',
        'missing in right: only-left.js',
      ]);
      writeFileSync(join(right, 'manifest.json'), '{"a":1}');
      writeFileSync(join(right, 'only-left.js'), 'left');
      expect(compareDirectories(left, right)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
