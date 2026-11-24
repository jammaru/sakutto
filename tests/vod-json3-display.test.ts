import { describe, expect, it } from 'vitest';
import { VodDisplayScheduler, VOD_MIN_DISPLAY_MS } from '@/captions/vod-json3-display';
import type { CaptionCue } from '@/captions/cues';

const cues: CaptionCue[] = [
  { id: 'a', startMs: 0, endMs: 500, text: 'One.' },
  { id: 'b', startMs: 600, endMs: 1_000, text: 'Two.' },
  { id: 'c', startMs: 1_100, endMs: 1_500, text: 'Three.' },
];
const translated = (cue: CaptionCue) => ({ original: cue.text, translation: 'JA:' + cue.text });

describe('VOD cue-start display scheduler', () => {
  it('paints cached translation at source start even after its natural end', () => {
    const scheduler = new VodDisplayScheduler();
    scheduler.reset(cues);
    expect(scheduler.update(0, 0, translated)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'a' }, pending: false },
    });
    expect(scheduler.update(600, 600, translated)).toBeNull();
    const late = new VodDisplayScheduler();
    late.reset(cues);
    expect(late.update(700, 700, translated)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'a' } },
    });
  });

  it('keeps FIFO order and gives every late cue full minimum dwell', () => {
    const scheduler = new VodDisplayScheduler();
    scheduler.reset(cues);
    scheduler.update(0, 0, translated);
    expect(scheduler.update(1_100, 1_100, translated)).toBeNull();
    expect(scheduler.update(1_100, 1_201, translated)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'b' } },
    });
    expect(scheduler.update(5_000, 2_401, translated)).toBeNull();
    expect(scheduler.update(5_000, 2_402, translated)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'c' } },
    });
    expect(scheduler.queuedCueIds).toEqual([]);
    expect(VOD_MIN_DISPLAY_MS).toBe(1_200);
  });

  it('shows original while pending and restarts dwell when JA arrives', () => {
    const scheduler = new VodDisplayScheduler();
    scheduler.reset(cues);
    let ready = false;
    const read = (cue: CaptionCue) => ({
      original: cue.text,
      translation: ready ? 'JA:' + cue.text : '',
    });
    expect(scheduler.update(0, 0, read)).toMatchObject({
      type: 'show',
      paint: { pending: true, translation: '' },
    });
    scheduler.update(600, 600, read);
    expect(scheduler.update(600, 1_000, read)).toBeNull();
    ready = true;
    expect(scheduler.update(600, 1_100, read)).toMatchObject({
      type: 'show',
      paint: { pending: false, translation: 'JA:One.' },
    });
    expect(scheduler.update(600, 2_300, read)).toBeNull();
    expect(scheduler.update(600, 2_301, read)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'b' } },
    });
  });

  it('does not allow later ready cues to overtake a pending cue', () => {
    const scheduler = new VodDisplayScheduler();
    scheduler.reset(cues);
    scheduler.update(0, 0, translated);
    const read = (cue: CaptionCue) => ({
      original: cue.text,
      translation: cue.id === 'b' ? '' : 'JA:' + cue.text,
    });
    expect(scheduler.update(1_100, 1_201, read)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'b' }, pending: true },
    });
    expect(scheduler.update(1_100, 5_000, read)).toBeNull();
    expect(scheduler.queuedCueIds).toEqual(['c']);
  });

  it('skips sound-only cues instead of blocking later dialogue', () => {
    const scheduler = new VodDisplayScheduler();
    scheduler.reset(cues);
    const read = (cue: CaptionCue) => (cue.id === 'a' ? null : translated(cue));
    expect(scheduler.update(1_100, 1_100, read)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'b' }, pending: false },
    });
    expect(scheduler.queuedCueIds).toEqual(['c']);
  });

  it('drops a terminally failed pending cue and advances the FIFO', () => {
    const scheduler = new VodDisplayScheduler();
    scheduler.reset(cues);
    scheduler.update(0, 0, (cue) => ({ original: cue.text, translation: '' }));
    const read = (cue: CaptionCue) => (cue.id === 'a' ? null : translated(cue));
    expect(scheduler.update(600, 100, read)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'b' }, pending: false },
    });
    expect(scheduler.queuedCueIds).toEqual([]);
  });

  it('flushes intentional seeks and starts at the destination cue only', () => {
    const scheduler = new VodDisplayScheduler();
    scheduler.reset(cues);
    scheduler.update(0, 0, translated);
    scheduler.seek(700);
    expect(scheduler.queuedCueIds).toEqual([]);
    expect(scheduler.update(700, 800, translated)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'b' } },
    });
    expect(scheduler.generation).toBeGreaterThan(1);
  });

  it('freezes new due selection while paused without resetting active dwell', () => {
    const scheduler = new VodDisplayScheduler();
    scheduler.reset(cues);
    scheduler.update(0, 0, translated);
    expect(scheduler.update(100, 500, translated, true)).toBeNull();
    expect(scheduler.update(500, 1_200, translated, true)).toBeNull();
    expect(scheduler.update(500, 1_200, translated)).toBeNull();
    expect(scheduler.update(600, 1_201, translated)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'b' } },
    });
  });

  it('selects the seek destination while paused but freezes dwell advancement', () => {
    const scheduler = new VodDisplayScheduler();
    scheduler.reset(cues);
    scheduler.update(0, 0, translated);
    scheduler.seek(700);
    expect(scheduler.update(700, 1_000, translated, true)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'b' } },
    });
    // Wall-clock dwell must not walk through the queue while the playhead is frozen.
    expect(scheduler.update(700, 2_500, translated, true)).toBeNull();
    expect(scheduler.update(1_200, 2_501, translated)).toMatchObject({
      type: 'show',
      paint: { cue: { id: 'c' } },
    });
  });

  it('keeps the final cue through minimum dwell and silence hold', () => {
    const scheduler = new VodDisplayScheduler();
    scheduler.reset([cues[0]!]);
    scheduler.update(0, 0, translated);
    expect(scheduler.update(5_000, 1_200, translated)).toBeNull();
    expect(scheduler.update(5_000, 1_201, translated)).toEqual({ type: 'clear', cueId: 'a' });
  });
});
