// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BATCHING } from '@/engine/text/plan';
import { DEFAULT_PIECE_CHARS } from '@/engine/text/sentences';
import { estimateTokens } from '@/engine/text/tokens';
import { benchBody, runFlow, stackLayout } from './support/page-flow';
import { CPU_COSTS, GPU_COSTS, promptSource } from './support/sim-runtime';

/**
 * The whole page path — scan, priority, packing, the real InBrowserEngine and its scheduler —
 * on a simulated llama.cpp with a virtual clock. The costs are shapes, not measurements: the
 * CPU pair follows the repo's own CPU bench, where a prompt token costs nearly as much as an
 * output token, and the GPU pair only says prefill is cheap. Nothing here is a claim about
 * a particular GPU.
 */
const FIRST_SCREEN = ['title', 'p1', 'p2'];

let unstack: () => void = () => undefined;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
  });
  document.documentElement.lang = 'en';
  document.body.innerHTML = benchBody('headline-in-header.html');
  unstack = stackLayout(document);
});

afterEach(() => {
  unstack();
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.documentElement.lang = '';
  document.documentElement.removeAttribute('data-sakutto-source-lang');
});

/** The longest a prompt can keep the page still on the CPU: one full piece of prefill. */
const CPU_PIECE_PREFILL_MS = (estimateTokens('a'.repeat(DEFAULT_PIECE_CHARS)) + 24) * 30;

describe('whole-page translation keeps moving', () => {
  it('fills the first screen first and never freezes for a packed prefill on the CPU', async () => {
    const result = await runFlow({ costs: CPU_COSTS, tier: 'c8', firstScreen: FIRST_SCREEN });

    // The headline lives in the article's own <header>. It used to be ranked as site
    // navigation and finished last, after every paragraph of the body.
    expect(promptSource(result.prompts[0] ?? '')).toBe('Funding the harbour libraries');
    expect(result.firstPaintMs).toBeLessThan(2_000);
    expect(result.firstScreenMs).toBeLessThan(result.totalMs * 0.3);
    // A 512-token packed prompt held the page still for its whole prefill (8.6 s here).
    expect(result.longestStillMs).toBeLessThan(CPU_PIECE_PREFILL_MS);
  }, 60_000);

  it('keeps the page moving on the WebGPU tier', async () => {
    const result = await runFlow({ costs: GPU_COSTS, tier: 'g', firstScreen: FIRST_SCREEN });

    expect(result.firstScreenMs).toBeLessThan(result.totalMs * 0.3);
    expect(result.longestStillMs).toBeLessThan(1_000);
  }, 60_000);

  it('keeps tok/s on the bar through a prefill longer than the hold window', async () => {
    // Prefill at 100 ms a token: one paragraph is a ten-second stretch with no output.
    const result = await runFlow({
      costs: { prefillMsPerToken: 100, decodeMsPerToken: 20, parallel: 1, backend: 'cpu-wasm' },
      tier: 'c8',
      firstScreen: FIRST_SCREEN,
    });

    expect(result.longestStillMs).toBeGreaterThan(8_000);
    expect(result.longestRatelessMs).toBe(0);
    expect(result.bars.some((bar) => bar.includes('tok/s'))).toBe(true);
  }, 60_000);

  it('sends each paragraph as its own prompt and packs only short labels', async () => {
    const result = await runFlow({ costs: GPU_COSTS, tier: 'g', firstScreen: FIRST_SCREEN });

    expect(result.prompts.length).toBeGreaterThan(0);
    for (const prompt of result.prompts) {
      const source = promptSource(prompt);
      const lines = source.split('\n');
      if (lines.length === 1) {
        expect(source.length).toBeLessThanOrEqual(DEFAULT_PIECE_CHARS);
        continue;
      }
      // A packed prompt holds labels, never a paragraph next to another paragraph.
      expect(estimateTokens(source)).toBeLessThanOrEqual(DEFAULT_BATCHING.maxBatchTokens);
      for (const line of lines) {
        expect(estimateTokens(line)).toBeLessThanOrEqual(DEFAULT_BATCHING.maxSegmentTokens);
      }
    }
  }, 60_000);
});
