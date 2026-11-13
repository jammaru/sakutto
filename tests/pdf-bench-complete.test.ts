import { describe, expect, it } from 'vitest';
import { isPdfBenchBlockFinished } from '../scripts/bench/pdf-complete';

describe('PDF bench completion', () => {
  it('treats skipped done blocks as finished even without a translation', () => {
    expect(isPdfBenchBlockFinished({ state: 'done', translation: '' })).toBe(true);
    expect(isPdfBenchBlockFinished({ state: 'failed', translation: '' })).toBe(true);
    expect(isPdfBenchBlockFinished({ state: 'running', translation: '途中' })).toBe(false);
    expect(isPdfBenchBlockFinished({ state: 'queued', translation: '' })).toBe(false);
    expect(isPdfBenchBlockFinished({ state: 'idle', translation: '' })).toBe(false);
  });
});
