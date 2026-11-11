import { describe, expect, it } from 'vitest';

/**
 * CPU greedy (`llama_sampler_greedy_apply`): keep the first index on a tied
 * max logit. WebGPU sampling must match this, not ggml's CPU `argmax` which
 * keeps the last index, and not the unpatched shader which did the same.
 */
function cpuGreedyArgmax(logits: readonly number[]): number {
  const first = logits[0];
  if (first === undefined) throw new Error('empty logits');
  let selected = 0;
  let best = first;
  for (let i = 1; i < logits.length; i += 1) {
    const value = logits[i];
    if (value !== undefined && value > best) {
      best = value;
      selected = i;
    }
  }
  return selected;
}

type Pair = { value: number; index: number };

/**
 * Sequential stand-in for `argmax.wgsl`: one workgroup, strided local scan,
 * then a tree reduction. `firstIndex` matches CPU greedy; `false` is the
 * unpatched shader (last index). GPU sampling is not used in the runtime.
 */
function webgpuArgmax(
  logits: readonly number[],
  workgroupSize: number,
  firstIndex: boolean,
): number {
  const local: Pair[] = [];
  for (let lid = 0; lid < workgroupSize; lid += 1) {
    let pair: Pair = { value: -1e9, index: -1 };
    for (let col = lid; col < logits.length; col += workgroupSize) {
      const val = logits[col];
      if (val === undefined) continue;
      if (firstIndex ? val > pair.value : val >= pair.value) {
        pair = { value: val, index: col };
      }
    }
    local.push(pair);
  }

  for (let offset = workgroupSize >> 1; offset > 0; offset >>= 1) {
    for (let lid = 0; lid < offset; lid += 1) {
      const a = local[lid];
      const b = local[lid + offset];
      if (!a || !b) continue;
      if (b.value > a.value) {
        local[lid] = b;
      } else if (b.value === a.value && (firstIndex ? b.index < a.index : b.index > a.index)) {
        local[lid] = b;
      }
    }
  }

  const winner = local[0];
  if (!winner || winner.index < 0) throw new Error('argmax produced no index');
  return winner.index;
}

const CASES: ReadonlyArray<{ name: string; logits: number[] }> = [
  { name: 'a unique max in the middle', logits: [0.1, 0.4, 0.9, 0.2, 0.8] },
  { name: 'the first logit is the max', logits: [3, 1, 2, 0] },
  { name: 'the last logit is the max', logits: [1, 2, 3, 9] },
  { name: 'two equal max logits, first should win', logits: [0.2, 1.5, 0.4, 1.5, 0.1] },
  { name: 'every logit tied', logits: [0.7, 0.7, 0.7, 0.7] },
  { name: 'a tie at the start of the row', logits: [2, 2, 1, 0] },
  { name: 'a tie at the end of the row', logits: [0, 1, 2, 2] },
  { name: 'three-way tie of the max', logits: [0.1, 4, 0.2, 4, 0.3, 4] },
  {
    name: 'vocab-shaped row with a late duplicate max',
    logits: Array.from({ length: 64 }, (_, i) => (i === 3 || i === 50 ? 9 : i * 0.01)),
  },
];

describe('GPU greedy tokens match CPU greedy', () => {
  it.each(CASES)('$name', ({ logits }) => {
    const cpu = cpuGreedyArgmax(logits);
    expect(webgpuArgmax(logits, 32, true)).toBe(cpu);
    expect(webgpuArgmax(logits, 16, true)).toBe(cpu);
    expect(webgpuArgmax(logits, 8, true)).toBe(cpu);
    expect(webgpuArgmax(logits, 1, true)).toBe(cpu);
  });

  it('disagrees with CPU on a tie before the shader comparison is flipped', () => {
    const tied = [0.2, 1.5, 0.4, 1.5, 0.1];
    expect(cpuGreedyArgmax(tied)).toBe(1);
    expect(webgpuArgmax(tied, 8, false)).toBe(3);
    expect(webgpuArgmax(tied, 8, true)).toBe(1);
  });
});
