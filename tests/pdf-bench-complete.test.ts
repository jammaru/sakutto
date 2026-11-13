import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPdfBenchBlockFinished, pdfBenchFinishedCount } from '../scripts/bench/pdf-complete';

describe('PDF bench completion', () => {
  it('treats skipped done blocks as finished even without a translation', () => {
    expect(isPdfBenchBlockFinished({ state: 'done', translation: '' })).toBe(true);
    expect(isPdfBenchBlockFinished({ state: 'failed', translation: '' })).toBe(true);
    expect(isPdfBenchBlockFinished({ state: 'running', translation: '途中' })).toBe(false);
    expect(isPdfBenchBlockFinished({ state: 'queued', translation: '' })).toBe(false);
    expect(isPdfBenchBlockFinished({ state: 'idle', translation: '' })).toBe(false);
    expect(
      pdfBenchFinishedCount([
        { state: 'done', translation: '' },
        { state: 'failed' },
        { state: 'running', translation: '途中' },
      ]),
    ).toBe(2);
  });

  it('does not close over Node helpers inside page.evaluate', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../scripts/bench/pdf-run.ts'),
      'utf8',
    );
    const start = source.indexOf('const snapshot = await reader.evaluate');
    const end = source.indexOf('pdfBenchFinishedCount(snapshot.entries)');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const evaluateCallback = source.slice(start, end);
    expect(evaluateCallback).not.toContain('isPdfBenchBlockFinished');
    expect(evaluateCallback).not.toContain('pdfBenchFinishedCount');
    expect(source.slice(end)).toContain('pdfBenchFinishedCount');
  });
});
