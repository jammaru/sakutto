import { describe, expect, it } from 'vitest';
import { AsrChunkStream, rollingCaptionDelta } from '@/captions/asr-stream';

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
});
