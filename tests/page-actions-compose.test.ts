import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('compose context menu', () => {
  it('keeps the editable item always visible instead of hiding it after open', () => {
    const source = readFileSync(
      new URL('../src/background/page-actions.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('setComposeMenuEnabled');
    expect(source).not.toMatch(/visible:\s*composeMenuEnabled/);
    expect(source).toContain("contexts: ['editable']");
  });
});
