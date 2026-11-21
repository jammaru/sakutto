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
export function fixtureGroundTruth(fixture: OcrFixture): string {
  return fixture.lines.map((line) => line.text).join('\n');
}
