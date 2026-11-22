import { describe, expect, it } from 'vitest';
import {
  computeJson3QualityReport,
  type DisplayTransition,
  type ExpectedJson3Manifest,
  type Json3Sample,
} from '../e2e/caption-quality-json3-helpers';

const manifest: ExpectedJson3Manifest = {
  schemaVersion: 1,
  scenarioId: 'helper-test',
  fixture: 'synthetic',
  language: 'en',
  targetLanguage: 'ja',
  synthetic: true,
  minimumCueCount: 1,
  cues: [
    {
      id: 'cue',
      source: 'Ready?',
      startMs: 7_000,
      endMs: 8_000,
      expectedJa: '§ja§Ready?',
      numericLexemes: [],
    },
  ],
};

function sample(atMs: number, mediaMs: number, phase = 'rate-2', epoch = 1): Json3Sample {
  return {
    atMs,
    mediaMs,
    rate: 2,
    paused: false,
    phase,
    epoch,
    caption: '',
    original: '',
    visible: false,
    pending: false,
    nativeText: '',
  };
}

function paint(
  atMs: number,
  mediaMs: number,
  censored = false,
  phase = 'rate-2',
): DisplayTransition {
  return {
    ...sample(atMs, mediaMs, phase),
    caption: '§ja§Ready?',
    original: 'Ready?',
    visible: true,
    reason: 'mutation',
    censored,
  };
}

const requests = { json3: 1, vtt: 0 };

describe('json3 quality evidence', () => {
  it('interpolates cue crossings only from independent playhead samples', () => {
    const report = computeJson3QualityReport(
      manifest,
      {
        samples: [sample(1_000, 6_000), sample(1_100, 8_000)],
        transitions: [paint(1_200, 7_100)],
        requests: [
          {
            action: 'start',
            cueId: 'cue',
            sourceText: 'Ready?',
            generation: 1,
            priority: 1,
            mode: 'vod-json3',
            reason: 'translate',
            atMs: 700,
            mediaMs: 7_000,
            phase: 'rate-2',
            epoch: 1,
          },
        ],
        scheduler: [],
      },
      requests,
      { phase: 'rate-2' },
    );
    expect(report.lag.details[0]).toMatchObject({
      crossingAtMs: 1_050,
      paintedAtMs: 1_200,
      lagMs: 150,
    });
  });

  it('uses valid backward-seek playhead brackets without request timestamps', () => {
    const report = computeJson3QualityReport(
      manifest,
      {
        samples: [sample(1_000, 8_000, 'seek-back', 2), sample(1_100, 7_000, 'seek-back', 2)],
        transitions: [{ ...paint(1_150, 7_000, false, 'seek-back'), epoch: 2 }],
        requests: [],
        scheduler: [],
      },
      requests,
      { phase: 'seek-back' },
    );
    expect(report.lag.details[0]).toMatchObject({ crossingAtMs: 1_100, lagMs: 50 });
  });

  it('rejects censored-only dwell and content as a pass', () => {
    const shown = paint(0, 7_000, false, 'normal');
    const hidden: DisplayTransition = {
      ...paint(10, 7_010, true, 'normal'),
      caption: '',
      original: '',
      visible: false,
      reason: 'mark',
    };
    const report = computeJson3QualityReport(
      manifest,
      {
        samples: [sample(0, 7_000, 'normal', 0), sample(50, 7_050, 'normal', 0)],
        transitions: [shown, hidden],
        requests: [],
        scheduler: [],
      },
      requests,
      { phase: 'normal' },
    );
    expect(report.dwell.intervals).toHaveLength(1);
    expect(report.dwell.intervals[0]?.censored).toBe(true);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        'no fully observed uncensored JA dwell interval',
        'missing JA cues: cue',
        'missing source cues: cue',
      ]),
    );
  });
});
