import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeEol } from './support/eol';

const privacy = normalizeEol(readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8'));
const reviewNotes = normalizeEol(
  readFileSync(new URL('../docs/CWS_REVIEW_NOTES.md', import.meta.url), 'utf8'),
);
const readme = normalizeEol(readFileSync(new URL('../README.md', import.meta.url), 'utf8'));
const readmeJa = normalizeEol(readFileSync(new URL('../README.ja.md', import.meta.url), 'utf8'));

const ENGLISH_HEADING = '# Privacy policy';
const JAPANESE_HEADING = '# プライバシーポリシー';

/** Lines of the file, so a heading is only matched where it starts a line. */
const lines = privacy.split('\n');

function sectionText(heading: string): string {
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`PRIVACY.md has no "${heading}" heading`);
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => /^# /u.test(line));
  return (next === -1 ? rest : rest.slice(0, next)).join('\n');
}

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

  /**
   * The public site splits PRIVACY.md at the two language headings, so exactly one of each
   * has to be present, and the English one has to come first.
   */
  it('keeps the two language headings the public site splits on', () => {
    const english = lines.indexOf(ENGLISH_HEADING);
    const japanese = lines.indexOf(JAPANESE_HEADING);
    expect(english).toBe(0);
    expect(japanese).toBeGreaterThan(english);
    expect(lines.filter((line) => line === ENGLISH_HEADING)).toHaveLength(1);
    expect(lines.filter((line) => line === JAPANESE_HEADING)).toHaveLength(1);
    expect(sectionText(ENGLISH_HEADING).trim().length).toBeGreaterThan(0);
    expect(sectionText(JAPANESE_HEADING).trim().length).toBeGreaterThan(0);
  });

  /**
   * The policy describes categories of data, not the tree. Anything below a commit URL, a
   * digest, or a `src/` path belongs in `docs/CWS_REVIEW_NOTES.md`, where it can be updated
   * with the code instead of dragging the published policy along.
   */
  it('does not turn the published policy back into an implementation spec', () => {
    expect(privacy).not.toMatch(/src\/[\w-]+\/[\w/-]+\.\w+/u);
    expect(privacy).not.toMatch(/\b[0-9a-f]{40}\b/u);
    expect(privacy).not.toMatch(/SHA-?256/iu);
    expect(privacy).not.toMatch(/ageNoticeShown|PLAMO_(?:NOTICE|LICENSE)_VERSION/u);
    expect(privacy).not.toMatch(/shadow (?:root|DOM)/iu);
    expect(privacy).not.toMatch(/\.part\b/u);
    // A "last updated" date is fine; a date the policy is re-checked against is not.
    expect(privacy).not.toMatch(/checked against the code/iu);
    expect(privacy).not.toMatch(/コードに合わせて確認/iu);
  });

  /**
   * The facts removed from the policy are still checked, just where a reviewer or a
   * maintainer can follow them to the code.
   */
  it('keeps reviewer-facing detail in the review notes', () => {
    expect(reviewNotes).toContain('ageNoticeShown');
    expect(reviewNotes).toContain('PLAMO_LICENSE_VERSION');
    expect(reviewNotes).toContain('2026-11-05');
    expect(reviewNotes).toMatch(/1,?200/u);
    expect(reviewNotes).toMatch(/1,?000/u);
    expect(reviewNotes).toContain('isTypedTextSelection');
    // The notes say which of the two documents is the stable one.
    expect(reviewNotes).toContain('stable user-facing policy');
  });
});
