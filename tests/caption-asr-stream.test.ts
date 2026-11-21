import { describe, expect, it } from 'vitest';
import { AsrChunkStream, rollingCaptionDelta } from '@/captions/asr-stream';
import { isCjkTarget } from '@/shared/languages';

describe('rollingCaptionDelta', () => {
  it('returns only the new words of a growing window', () => {
    expect(rollingCaptionDelta('I had', 'I had some technical difficulties')).toEqual({
      delta: ' some technical difficulties',
      continued: true,
    });
  });

  it('keeps coverage when a window drops its leading words', () => {
    expect(
      rollingCaptionDelta(
        'I had some technical difficulties during my talk this morning',
        'during my talk this morning, so I ran back home',
      ),
    ).toEqual({ delta: ', so I ran back home', continued: true });
  });

  it('treats an unrelated window as a new sentence', () => {
    expect(rollingCaptionDelta('old speech', 'So, hi everyone.')).toEqual({
      delta: 'So, hi everyone.',
      continued: false,
    });
  });
});

describe('AsrChunkStream', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function harness() {
    const lines: string[] = [];
    const cancelled: string[] = [];
    let playhead = 0;
    const resolvers = new Map<number, (value: string) => void>();
    const stream = new AsrChunkStream({
      spaceDelimited: () => true,
      now: () => 0,
      playheadMs: () => playhead,
      translate: (_delta, _context, sequence) =>
        new Promise<string>((resolve) => resolvers.set(sequence, resolve)),
      cancel: (delta) => cancelled.push(delta),
      onLine: (_source, translation) => lines.push(translation),
    });
    return {
      stream,
      lines,
      cancelled,
      finish(sequence: number, text: string): void {
        resolvers.get(sequence)?.(text);
      },
      seek(ms: number): void {
        playhead = ms;
      },
    };
  }

  it('appends each stable delta in original order', async () => {
    const h = harness();
    h.stream.observe('I had');
    h.stream.observe('I had some technical difficulties');
    h.finish(0, 'I had');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.lines).toEqual(['I had']);
    h.finish(1, 'some technical difficulties');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.lines).toEqual(['I had', 'I had some technical difficulties']);
    expect(h.cancelled).toEqual([]);
  });

  it('drops work whose playhead deadline has passed', async () => {
    const h = harness();
    h.stream.observe('I had');
    h.seek(3_000);
    h.stream.tick(3_000);
    expect(h.cancelled).toEqual(['I had']);
    h.finish(0, 'I had');
    await Promise.resolve();
    expect(h.lines).toEqual([]);
  });

  it('forgets the raw window on reset so a repeated caption is translated again', () => {
    const h = harness();
    h.stream.observe('Alpha beta');
    h.stream.reset();
    h.stream.observe('Alpha beta');
    expect(h.cancelled).toEqual(['Alpha beta']);
  });

  it('retires an in-flight delta when a new sentence starts instead of reusing its sequence', async () => {
    const h = harness();
    h.stream.observe('Alpha beta');
    h.finish(0, 'Alpha beta');
    await flush();
    expect(h.lines).toEqual(['Alpha beta']);

    h.stream.observe('Alpha beta gamma'); // seq 1, in flight
    h.stream.observe('Delta epsilon'); // new sentence: seq 1 must be retired
    expect(h.cancelled).toEqual([' gamma']);

    h.finish(1, ' gamma'); // the stale result cannot paint the new sentence
    await flush();
    expect(h.lines).toEqual(['Alpha beta']);

    h.finish(2, 'Delta epsilon'); // fresh, monotonic sequence
    await flush();
    expect(h.lines).toEqual(['Alpha beta', 'Delta epsilon']);

    h.stream.observe('Delta epsilon zeta'); // seq 3
    h.finish(3, 'zeta');
    await flush();
    expect(h.lines).toEqual(['Alpha beta', 'Delta epsilon', 'Delta epsilon zeta']);
  });

  it('drops queued deltas from the old sentence without reusing their sequences', async () => {
    const h = harness();
    h.stream.observe('I had'); // seq 0, in flight
    h.stream.observe('I had some'); // seq 1, queued behind seq 0
    h.stream.observe('A new sentence'); // stale work retired
    expect(h.cancelled).toEqual(['I had']);

    h.finish(0, 'I had');
    await flush();
    expect(h.lines).toEqual([]);
    h.finish(1, 'some');
    await flush();
    expect(h.lines).toEqual([]);
    h.finish(2, 'A new sentence');
    await flush();
    expect(h.lines).toEqual(['A new sentence']);
  });

  function targetHarness(target: string, outputs: readonly string[]) {
    const lines: string[] = [];
    let index = 0;
    const stream = new AsrChunkStream({
      spaceDelimited: () => !isCjkTarget(target),
      now: () => 0,
      playheadMs: () => 0,
      translate: async () => outputs[index++] ?? '',
      cancel: () => undefined,
      onLine: (_source, translation) => lines.push(translation),
    });
    return { stream, lines };
  }

  it('joins deltas in the target language, not the source language', async () => {
    expect(isCjkTarget('ja')).toBe(true);
    expect(isCjkTarget('zh-Hant')).toBe(true);
    expect(isCjkTarget('ja-easy')).toBe(true);
    expect(isCjkTarget('th')).toBe(true);
    expect(isCjkTarget('en')).toBe(false);

    const toJa = targetHarness('ja', ['駅は夜明けに開きます。', '赤い列車が待っています。']);
    toJa.stream.observe('The station opens at dawn.');
    await flush();
    toJa.stream.observe('The station opens at dawn. A red train waits.');
    await flush();
    expect(toJa.lines).toEqual([
      '駅は夜明けに開きます。',
      '駅は夜明けに開きます。赤い列車が待っています。',
    ]);

    const toEn = targetHarness('en', ['The station opens at dawn.', 'A red train waits.']);
    toEn.stream.observe('駅は夜明けに開きます。');
    await flush();
    toEn.stream.observe('駅は夜明けに開きます。赤い列車が待っています。');
    await flush();
    expect(toEn.lines).toEqual([
      'The station opens at dawn.',
      'The station opens at dawn. A red train waits.',
    ]);
  });

  it('keeps word boundaries for Latin fallback text under a CJK target', async () => {
    const h = targetHarness('ja', ['I had', 'technical difficulties']);
    h.stream.observe('I had');
    await flush();
    h.stream.observe('I had technical difficulties');
    await flush();
    expect(h.lines[1]).toBe('I had technical difficulties');
  });

  it('separates marked Latin output even when the target is CJK', async () => {
    const h = targetHarness('ja', ['§ja§I had', '§ja§technical difficulties']);
    h.stream.observe('I had');
    await flush();
    h.stream.observe('I had technical difficulties');
    await flush();
    expect(h.lines[1]).toBe('§ja§I had §ja§technical difficulties');
  });
});
