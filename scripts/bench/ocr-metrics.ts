import type { BenchQuad, OcrFixture } from './ocr-fixtures.ts';

export interface ErrorRate {
  readonly distance: number;
  readonly referenceUnits: number;
  readonly rate: number;
}
export interface DetectionRecall {
  readonly matched: number;
  readonly reference: number;
  readonly recall: number;
  readonly threshold: number;
}
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** NFC plus whitespace folding; line breaks are not allowed to hide reading-order errors. */
export function normalizeOcrText(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}
export function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? Infinity) + 1,
        (current[j - 1] ?? Infinity) + 1,
        (previous[j - 1] ?? Infinity) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length] ?? 0;
}
/** Unicode-code-point CER after normalizeOcrText. */
export function characterErrorRate(reference: string, hypothesis: string): ErrorRate {
  const a = Array.from(normalizeOcrText(reference));
  const b = Array.from(normalizeOcrText(hypothesis));
  const distance = levenshtein(a, b);
  return { distance, referenceUnits: a.length, rate: distance / Math.max(1, a.length) };
}
/** Whitespace-token WER after normalizeOcrText; no Japanese morphological segmenter is used. */
export function wordErrorRate(reference: string, hypothesis: string): ErrorRate {
  const normalizedA = normalizeOcrText(reference);
  const normalizedB = normalizeOcrText(hypothesis);
  const a = normalizedA ? normalizedA.split(' ') : [];
  const b = normalizedB ? normalizedB.split(' ') : [];
  const distance = levenshtein(a, b);
  return { distance, referenceUnits: a.length, rate: distance / Math.max(1, a.length) };
}
function box(quad: BenchQuad): Box {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}
export function intersectionOverUnion(a: BenchQuad, b: BenchQuad): number {
  const x = box(a);
  const y = box(b);
  const intersection =
    Math.max(0, Math.min(x.right, y.right) - Math.max(x.left, y.left)) *
    Math.max(0, Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top));
  const area = (value: Box) =>
    Math.max(0, value.right - value.left) * Math.max(0, value.bottom - value.top);
  const union = area(x) + area(y) - intersection;
  return union > 0 ? intersection / union : 0;
}
/**
 * Detection recall proxy: maximum-IoU-first, one-to-one greedy matching of axis-aligned
 * bounding boxes around GT and predicted quads. A pair counts only at IoU >= 0.30.
 * This is not polygon-level PaddleOCR detection evaluation and has no precision component.
 */
export function detectionRecallProxy(
  reference: readonly BenchQuad[],
  predicted: readonly BenchQuad[],
  threshold = 0.3,
): DetectionRecall {
  const pairs = reference
    .flatMap((quadA, a) =>
      predicted.map((quadB, b) => ({ a, b, iou: intersectionOverUnion(quadA, quadB) })),
    )
    .filter((pair) => pair.iou >= threshold)
    .sort((x, y) => y.iou - x.iou || x.a - y.a || x.b - y.b);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  for (const pair of pairs) {
    if (usedA.has(pair.a) || usedB.has(pair.b)) continue;
    usedA.add(pair.a);
    usedB.add(pair.b);
  }
  return {
    matched: usedA.size,
    reference: reference.length,
    recall: usedA.size / Math.max(1, reference.length),
    threshold,
  };
}
export function practicality(
  cer: number,
  recall: number,
): 'practical' | 'marginal' | 'not practical' {
  if (recall >= 0.8 && cer <= 0.15) return 'practical';
  if (recall >= 0.5 && cer <= 0.4) return 'marginal';
  return 'not practical';
}
export function microErrorRate(
  reference: string,
  hypothesis: string,
  kind: 'character' | 'word',
): ErrorRate {
  return kind === 'character'
    ? characterErrorRate(reference, hypothesis)
    : wordErrorRate(reference, hypothesis);
}

/** Match hypothesis lines to ground truth by text similarity and score reading order. */
export function lineOrderAccuracy(
  reference: readonly string[],
  hypothesis: readonly string[],
): { accuracy: number; matched: number; reference: number } {
  const normalizedReference = reference.map(normalizeOcrText);
  const normalizedHypothesis = hypothesis.map(normalizeOcrText);
  const candidates = normalizedHypothesis.flatMap((text, index) =>
    normalizedReference.map((expected, rank) => ({
      index,
      rank,
      similarity:
        1 -
        characterErrorRate(expected, text).rate +
        (expected === text ? 0.5 : 0),
    })),
  );
  const usedHypothesis = new Set<number>();
  const usedRank = new Set<number>();
  const matches: { index: number; rank: number }[] = [];
  for (const candidate of candidates.sort((a, b) => b.similarity - a.similarity)) {
    if (candidate.similarity < 0.55) continue;
    if (usedHypothesis.has(candidate.index) || usedRank.has(candidate.rank)) continue;
    usedHypothesis.add(candidate.index);
    usedRank.add(candidate.rank);
    matches.push({ index: candidate.index, rank: candidate.rank });
  }
  matches.sort((a, b) => a.index - b.index);
  let correct = 0;
  for (let position = 1; position < matches.length; position += 1) {
    const previous = matches[position - 1];
    const current = matches[position];
    if (previous && current && previous.rank <= current.rank) correct += 1;
  }
  return {
    accuracy: matches.length < 2 ? (matches.length === 0 ? 0 : 1) : correct / (matches.length - 1),
    matched: matches.length,
    reference: reference.length,
  };
}

/** Column order: left-to-right and top-to-bottom, for two-page newspaper layouts. */
export function columnOrderAccuracy(
  reference: readonly BenchQuad[],
  hypothesis: readonly BenchQuad[],
  pageWidth: number,
): number {
  const column = (quad: BenchQuad): number => {
    const center = quad.reduce((sum, point) => sum + point.x, 0) / 4;
    return center < pageWidth / 2 ? 0 : 1;
  };
  const expected = reference.map(column);
  const observed = hypothesis.map(column);
  if (expected.length < 2 || observed.length === 0 || new Set(expected).size < 2) return 1;
  const inversions = observed.filter((value, index) => index > 0 && value < (observed[index - 1] ?? value)).length;
  return 1 - inversions / Math.max(1, observed.length - 1);
}

/** Mean best IoU between paragraph groups built from adjacent matched lines. */
export function blockIoU(
  reference: readonly BenchQuad[],
  hypothesis: readonly BenchQuad[],
): number {
  const group = (quads: readonly BenchQuad[]): BenchQuad[][] => {
    const groups: BenchQuad[][] = [];
    for (const quad of quads) {
      const last = groups.at(-1)?.at(-1);
      const gap = last ? Math.min(...[0, 1, 2, 3].map((index) => quad[index]?.y ?? 0)) - Math.max(...[0, 1, 2, 3].map((index) => last[index]?.y ?? 0)) : Infinity;
      if (last && Math.abs(gap) < 24) groups.at(-1)?.push(quad);
      else groups.push([quad]);
    }
    return groups;
  };
  const referenceGroups = group(reference);
  const hypothesisGroups = group(hypothesis);
  if (referenceGroups.length === 0) return 1;
  let total = 0;
  for (const groupQuads of hypothesisGroups) {
    const box = (quads: readonly BenchQuad[]) => ({
      left: Math.min(...quads.flatMap((quad) => quad.map((point) => point.x))),
      right: Math.max(...quads.flatMap((quad) => quad.map((point) => point.x))),
      top: Math.min(...quads.flatMap((quad) => quad.map((point) => point.y))),
      bottom: Math.max(...quads.flatMap((quad) => quad.map((point) => point.y))),
    });
    const candidate = box(groupQuads);
    let best = 0;
    for (const expected of referenceGroups) {
      const target = box(expected);
      const intersection = Math.max(0, Math.min(candidate.right, target.right) - Math.max(candidate.left, target.left)) * Math.max(0, Math.min(candidate.bottom, target.bottom) - Math.max(candidate.top, target.top));
      const areaA = (candidate.right - candidate.left) * (candidate.bottom - candidate.top);
      const areaB = (target.right - target.left) * (target.bottom - target.top);
      best = Math.max(best, intersection / Math.max(1, areaA + areaB - intersection));
    }
    total += best;
  }
  return total / hypothesisGroups.length;
}
export function fixtureGroundTruth(fixture: OcrFixture): string {
  return fixture.lines.map((line) => line.text).join('\n');
}
