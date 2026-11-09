import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const AMO_SUMMARY_LIMIT = 250;

const metadata = JSON.parse(
  readFileSync(new URL('../amo-metadata.json', import.meta.url), 'utf8'),
) as {
  summary: Record<string, string>;
  description: Record<string, string>;
};
const listing = readFileSync(new URL('../docs/AMO_LISTING.md', import.meta.url), 'utf8');
const notes = readFileSync(new URL('../docs/AMO_REVIEW_NOTES.md', import.meta.url), 'utf8');
const upload = readFileSync(new URL('../docs/AMO_UPLOAD.md', import.meta.url), 'utf8');
const manifest = readFileSync(new URL('../src/shared/manifest.ts', import.meta.url), 'utf8');
const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');

describe('AMO listing copy', () => {
  it('keeps summaries within the AMO 250-character limit', () => {
    for (const [locale, text] of Object.entries(metadata.summary)) {
      expect(text.length, locale).toBeLessThanOrEqual(AMO_SUMMARY_LIMIT);
    }
  });

  it('does not require Windows and names the four Firefox shortcuts', () => {
    const english = metadata.description['en-US'];
    const japanese = metadata.description.ja;
    expect(english).toContain('Firefox 153 or later on desktop (Windows, macOS, or Linux)');
    expect(english).toContain('Tested on Windows');
    expect(english).not.toContain('Requires Firefox 153 or later on Windows');
    expect(english).toContain('Alt+Shift+A (page)');
    expect(english).toContain('Alt+Shift+B (bilingual)');
    expect(english).toContain('Alt+Shift+S (selection)');
    expect(english).toContain('Alt+Shift+T (typed text)');
    expect(english).toContain("Firefox's add-on shortcut settings");
    expect(japanese).toContain('デスクトップの Firefox 153 以降');
    expect(japanese).toContain('確認したのは Windows');
    expect(japanese).not.toContain('Windows の Firefox 153 以降が必要');
    expect(japanese).toContain('Alt+Shift+A（ページ）');
    expect(japanese).toContain('Alt+Shift+B（対訳）');
    expect(japanese).toContain('Alt+Shift+S（選択）');
    expect(japanese).toContain('Alt+Shift+T（入力中の翻訳）');
    expect(japanese).toContain('アドオンのショートカット設定');
    expect(listing).toContain(english);
    expect(listing).toContain(japanese);
  });

  it('does not filter desktop OS in the Firefox manifest', () => {
    expect(manifest).toContain('strict_min_version: FIREFOX_STRICT_MIN_VERSION');
    expect(manifest).not.toMatch(/gecko_android/);
    expect(config).not.toMatch(/gecko_android/);
    expect(notes).not.toContain('First target is Windows');
    expect(notes).toContain('The manifest has no OS filter');
    expect(notes).toContain('gecko_android');
  });

  it('tells the owner to upload screenshots and paste reviewer notes after sign', () => {
    expect(upload).toContain('web-ext sign');
    expect(upload).toContain('スクリーンショットをアップロードする');
    expect(upload).toContain('Upload screenshots');
    expect(upload).toContain('Notes for Reviewers');
  });
});
