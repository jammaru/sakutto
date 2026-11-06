import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const privacy = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const readmeJa = readFileSync(new URL('../README.ja.md', import.meta.url), 'utf8');

describe('consent documentation', () => {
  /**
   * The stored record says which notice was shown, never that an age or a guardian was
   * checked. A privacy policy that promises more than the code does is the thing to catch.
   */
  it('does not claim the extension verifies age or guardian consent', () => {
    for (const [name, text] of [
      ['PRIVACY.md', privacy],
      ['README.md', readme],
      ['README.ja.md', readmeJa],
    ] as const) {
      expect(text, name).not.toMatch(/guardian:\s*true/);
      expect(text, name).not.toMatch(/verifies (?:the user's )?age/i);
      // Only a negated mention is allowed ("it is not a record that an age was checked").
      expect(text, name).not.toMatch(/年齢を(?:確認します|確認しました)/);
      expect(text, name).not.toMatch(/保護者の同意を(?:確認します|確認しました)/);
    }
  });

  it('describes the notice version separately from the license version', () => {
    expect(privacy).toContain('PLAMO_NOTICE_VERSION');
    expect(privacy).toContain('ageNoticeShown');
  });

  it('names the current notice version in the policy', () => {
    expect(privacy).toContain('2026-11-06');
  });

  it('says the model stays on the device when the notice is shown again', () => {
    expect(privacy).toMatch(/model file .*(?:stays|remains) on (?:this|the) device/i);
  });
});
