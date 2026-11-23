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
  firstTranslatedBlockFromRunStartMs: number;
  fullDocumentMs: number;
}
interface ScanRun {
  variant: string;
  cer: number;
  wer: number;
  crossColumnCovers: number;
  lines: number;
  ms: number;
  covered: number;
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

/** Markdown rows are keyed by their first cell in the scan README's tables. */
function scanReadmeRow(markdown: string, label: string): string[] {
  const row = markdown
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('| ') && line.split('|')[1]?.trim() === label);
  if (!row) throw new Error('no scan README row for ' + label);
  return row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

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
    expect(rowWithLabel(PR_BODY, '最初の訳文が出るまで（実行開始から）')[2]).toBe(
      String(summary.firstTranslatedBlockFromRunStartMs) + ' ms',
    );
    expect(rowWithLabel(PR_BODY, '最初の訳文が出るまで（ページ処理から）')[2]).toBe(
      String(summary.firstTranslatedBlockMs) + ' ms',
    );
    expect(rowWithLabel(PR_BODY, '全文処理時間（fake engine）')[2]).toBe(
      String(summary.fullDocumentMs) + ' ms',
    );
  });

  it('compares first-block latency using the definition both artifacts record', () => {
    const baseline = json<{ summary: Summary }>('bench/results/pdf-quality/baseline.json').summary;
    const final = json<{ summary: Summary }>('bench/results/pdf-quality/final.json').summary;
    const runStartRow = rowWithLabel(PR_BODY, '最初の訳文が出るまで（実行開始から）');
    expect(runStartRow[1]).toBe(String(baseline.firstTranslatedBlockFromRunStartMs) + ' ms');
    expect(runStartRow[2]).toBe(String(final.firstTranslatedBlockFromRunStartMs) + ' ms');
    // The older baseline has no page-level measurement, so it must not be shown in that row.
    expect(rowWithLabel(PR_BODY, '最初の訳文が出るまで（ページ処理から）')[1]).toBe('—');
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

  it('keeps the scan README tables in step with the committed runs', () => {
    const readme = read('bench/results/scan-ocr/README.md');
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
      const cells = scanReadmeRow(readme, variant);
      expect([cells[2], cells[3], cells[4], cells[5], cells[7]], variant).toEqual([
        (run.cer * 100).toFixed(1) + '%',
        (run.wer * 100).toFixed(1) + '%',
        String(run.crossColumnCovers),
        (run.ms / 1000).toFixed(1) + ' s',
        run.covered.toFixed(3),
      ]);
    }
    const high = json<ScanRun[]>('bench/results/scan-ocr/high-tier.json').find(
      (entry) => entry.variant === 'default-1600',
    );
    expect(high).toBeDefined();
    if (!high) return;
    const cells = scanReadmeRow(readme, 'default-1600 (high)');
    expect([cells[2], cells[3], cells[4]]).toEqual([
      (high.cer * 100).toFixed(1) + '%',
      String(high.crossColumnCovers),
      (high.ms / 1000).toFixed(1) + ' s',
    ]);
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

describe('committed bench history', () => {
  it('B4: has one 12-column schema for the header and every row', () => {
    const lines = read('bench/results/pdf-quality/history.md').split('\n');
    const table = lines.filter((line) => line.startsWith('|'));
    expect(table.length).toBeGreaterThan(2);
    for (const line of table) {
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim());
      expect(cells, line).toHaveLength(12);
    }
    expect(table[0]).toContain('first block from page ms');
    expect(table[0]).toContain('first block from run ms');
    // The last final row is the committed final.json result.
    const final = json<{ summary: Summary }>('bench/results/pdf-quality/final.json').summary;
    const last = table
      .at(-1)!
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    expect(last[10]).toBe(String(final.firstTranslatedBlockFromRunStartMs));
    expect(last[11]).toBe(String(final.fullDocumentMs));
  });
});

describe('current DSH review blockers', () => {
  it('B5: the first-block narrative uses the committed final summary value', () => {
    const final = json<{ summary: Summary }>('bench/results/pdf-quality/final.json').summary;
    const value = String(final.firstTranslatedBlockFromRunStartMs) + ' ms';
    const row = rowWithLabel(PR_BODY, '最初の訳文が出るまで（実行開始から）');
    expect(row[2]).toBe(value);
    const narrative = PR_BODY.split('\n').find((line) => line.includes('実行開始からの値（'));
    expect(narrative, 'narrative sentence with run-start latency').toBeDefined();
    expect(narrative).toContain(row[1] + ' → ' + value);
  });
});
