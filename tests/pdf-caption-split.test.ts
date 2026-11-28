import { describe, expect, it } from 'vitest';
import { isCaptionLine, layoutPage } from '@/pdf/layout';
import { groupLines } from '@/pdf/lines';
import { piece } from './support/pdf-pieces';

describe('caption detection and overlong caption splitting (#170)', () => {
  it('distinguishes real captions from prose sentences referencing a figure or table', () => {
    expect(isCaptionLine('Figure 1: Overview of the training pipeline.')).toBe(true);
    expect(isCaptionLine('Table 3. Results across all benchmarks.')).toBe(true);
    expect(isCaptionLine('Fig. 2 Example caption without punctuation.')).toBe(true);
    expect(isCaptionLine('Table 2 Budget-matching adjustments.')).toBe(true);
    expect(isCaptionLine('Figure 1a: Left panel.')).toBe(true);
    expect(isCaptionLine('Figure 1 (a) Overview.')).toBe(true);
    expect(isCaptionLine('Table 2')).toBe(true);
    expect(isCaptionLine('図1 処理の流れ')).toBe(true);
    expect(isCaptionLine('表2 比較結果')).toBe(true);

    expect(isCaptionLine('Table 2 lists the three budgets and their residual mismatch.')).toBe(
      false,
    );
    expect(isCaptionLine('Table 1 and Fig. 1 summarize final capacity distributions.')).toBe(false);
    expect(isCaptionLine('Figure 3 displays the normalized distance between rankings.')).toBe(
      false,
    );
    expect(isCaptionLine('Table 3 reports results for the nine-system evaluation set.')).toBe(
      false,
    );
    expect(isCaptionLine('Figure 2a shows the convergence curve under warm restarts.')).toBe(false);
  });

  it('classifies a long paragraph opening with "Table 2 lists..." as prose and splits it', () => {
    const rows = [
      'Table 2 lists the three budgets, the adjustment that holds each, and the residual mismatch.',
      'Suppose we want a looped model at 200M parameters that repeats the middle six layers twice.',
      'The matched baseline has twelve physical layers, hidden size 1280, and 192 experts per layer.',
      'The six extra layer executions increase per-token compute, so we narrow the hidden width.',
      'Narrowing the hidden width also shrinks every expert network, which lowers total parameters.',
      'To recover the parameter count, we raise the per-layer expert count from 192 to 288 experts.',
      'After both adjustments, per-token compute lands within three percent of the baseline model.',
      'Both compute counts are measured at the mean document length within packed training contexts.',
      'Every measurement includes the attention cost that scales with the sequence length in full.',
    ];
    const lines = groupLines(
      rows.map((text, idx) => piece(text, 70, 100 + idx * 12, 470, { em: 10 })),
    );
    const layout = layoutPage(lines, undefined, { width: 612, height: 792 });

    expect(layout.blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of layout.blocks) {
      expect(block.role).toBe('prose');
      expect(block.text.length).toBeLessThanOrEqual(650);
    }
  });

  it('splits an overlong real caption at sentence boundaries while preserving caption role', () => {
    const rows = [
      'Figure 1: Overview of the multi-stage pipeline used across all experiments in this study.',
      'Stage one normalizes raw observations from every sensor stream into a shared frame rate.',
      'Stage two aligns the temporal windows and removes corrupted packets before feature extraction.',
      'Stage three trains a lightweight encoder on the aligned windows using a contrastive objective.',
      'Stage four evaluates transfer accuracy on held-out domains without fine-tuning the backbone.',
      'Stage five aggregates calibration metrics across five random seeds and reports confidence intervals.',
      'Dashed arrows indicate optional skip connections that are disabled during the ablation runs.',
      'Shaded regions denote one standard deviation measured over the full validation benchmark suite.',
    ];
    const lines = groupLines(
      rows.map((text, idx) => piece(text, 70, 100 + idx * 12, 470, { em: 10 })),
    );
    const layout = layoutPage(lines, undefined, { width: 612, height: 792 });

    expect(layout.blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of layout.blocks) {
      expect(block.role).toBe('caption');
      expect(block.text.length).toBeLessThanOrEqual(650);
    }
  });
});
