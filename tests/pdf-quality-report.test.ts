import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const json = <T>(path: string): T => JSON.parse(read(path)) as T;

interface Summary {
  mixedLanguageRate: number;
  overflowRate: number;
  readingOrderAccuracy: number;
  firstTranslatedBlockMs: number;
  fullDocumentMs: number;
}
interface ScanRun {
  variant: string;
  cer: number;
  wer: number;
  crossColumnCovers: number;
  lines: number;
  ms: number;
}

/** Markdown cells are padded by Prettier and emphasised with **; compare their bare values. */
function rowWithLabel(markdown: string, label: string): string[] {
  const row = markdown
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('| ') && line.split('|')[1]?.trim() === label);
  if (!row) throw new Error('no markdown row for ' + label);
  return row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim().replace(/\*\*/gu, ''));
}

const PR_BODY = read('bench/results/pdf-quality/PR_BODY.md');

describe('committed quality report matches its raw data', () => {
  it('uses the final summary from final.json in the metrics table', () => {
    const summary = json<{ summary: Summary }>('bench/results/pdf-quality/final.json').summary;
    expect(rowWithLabel(PR_BODY, 'はみ出し/ブロック')[2]).toBe(summary.overflowRate.toFixed(3));
    expect(rowWithLabel(PR_BODY, 'ブロック内言語混在率')[2]).toBe(
      (summary.mixedLanguageRate * 100).toFixed(1) + '%',
    );
    expect(rowWithLabel(PR_BODY, '2 カラム読み順正解率')[2]).toBe(
      (summary.readingOrderAccuracy * 100).toFixed(1) + '%',
    );
    expect(rowWithLabel(PR_BODY, '最初の訳文が出るまで（ページ単位）')[2]).toBe(
      String(summary.firstTranslatedBlockMs) + ' ms',
    );
    expect(rowWithLabel(PR_BODY, '全文処理時間（fake engine）')[2]).toBe(
      String(summary.fullDocumentMs) + ' ms',
    );
  });

  it('uses the scan OCR report for every real-scan row', () => {
    const runs = json<ScanRun[]>('bench/results/scan-ocr/report.json');
    for (const variant of [
      'baseline-1x',
      'shipped-baseline',
      'default-1600',
      'gray+contrast-1600',
      'dpi300',
      'sauvola',
    ]) {
      const run = runs.find((entry) => entry.variant === variant);
      expect(run, variant).toBeDefined();
      if (!run) continue;
      expect(rowWithLabel(PR_BODY, variant).slice(1, 6), variant).toEqual([
        (run.cer * 100).toFixed(1) + '%',
        (run.wer * 100).toFixed(1) + '%',
        String(run.crossColumnCovers),
        String(run.lines),
        (run.ms / 1000).toFixed(1) + ' s',
      ]);
    }
  });

  it('uses the high-tier run for the High row', () => {
    const run = json<ScanRun[]>('bench/results/scan-ocr/high-tier.json').find(
      (entry) => entry.variant === 'default-1600',
    );
    expect(run).toBeDefined();
    if (!run) return;
    expect(rowWithLabel(PR_BODY, 'default-1600 (High)').slice(1, 6)).toEqual([
      (run.cer * 100).toFixed(1) + '%',
      (run.wer * 100).toFixed(1) + '%',
      String(run.crossColumnCovers),
      String(run.lines),
      (run.ms / 1000).toFixed(1) + ' s',
    ]);
  });
});
