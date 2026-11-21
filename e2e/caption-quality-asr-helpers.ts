import type { CaptionSample, MetricResult, QualityReport } from './caption-quality-helpers';
import { metric, THRESHOLDS } from './caption-quality-helpers';
/** One native ASR chunk and the clean Japanese overlay expected for it. */
export interface AsrChunk {
  /** Raw text painted by the native YouTube caption window. */
  native: string;
  /** Expected Sakutto overlay caption: fake-engine marker + cleaned chunk text. */
  expected: string;
  /** Pure sound tags are dropped entirely and have no expected overlay text. */
  sound?: boolean;
}

export interface AsrQualityRun {
  chunks: readonly AsrChunk[];
  markers: readonly string[];
}

const FAKE_MARKER = /§[a-z-]+§/gu;
/** Standalone sentinels that must never appear in a translated caption. */
const MARKER_TOKEN = /\b(?:S\d{1,2}|ED|NC|RS|E|T|S)\b/u;
/** Repeated English words inside a Japanese line are ASR stutter leftovers. */
const STUTTER_FRAGMENT = /\b([A-Za-z]{1,8}(?: +[A-Za-z]{1,8}){0,2})(?: +\1)+\b/iu;
const SOUND_WORD =
  'musical|music|instrumental|singing|laughter|laughing|applause|clapping|noise|inaudible|silence|背景音|音楽|拍手|笑い声|効果音|無音';
/** Bracketed/note tags and bare sound words, in either the translation or the original. */
const OVERLAY_SOUND_TAG = new RegExp(
  `(?:\\[[^\\]]{1,32}\\]|[♪♫♩]|(?<![\\p{L}])(?:${SOUND_WORD})(?![\\p{L}]))`,
  'iu',
);

function visibleOverlayText(sample: CaptionSample): string {
  return (sample.caption + ' ' + sample.original).replace(FAKE_MARKER, ' ').trim();
}

function hasMarker(text: string, configured: readonly string[]): boolean {
  if (MARKER_TOKEN.test(text)) return true;
  const escape = (token: string): string => token.replace(/[^\w]/gu, '\\$&');
  return configured.some((token) => new RegExp('\\b' + escape(token) + '\\b', 'u').test(text));
}

/**
 * ASR metrics. Latency is attributed to the wall-clock moment the native chunk text
 * changes (sampled every 50ms), not to media time: rolling chunks share a start time.
 */
export function computeAsrQualityReport(
  asr: AsrQualityRun,
  samples: readonly CaptionSample[],
): QualityReport {
  const markerLeaks = samples.filter((sample) =>
    hasMarker(visibleOverlayText(sample), asr.markers),
  );
  const soundTagTranslations = samples.reduce(
    (worst, sample) => Math.max(worst, sample.soundTagTranslations),
    0,
  );
  const soundTagFrames = samples.filter(
    (sample) =>
      (sample.caption.length > 0 && OVERLAY_SOUND_TAG.test(sample.caption)) ||
      (sample.original.length > 0 && OVERLAY_SOUND_TAG.test(sample.original)),
  ).length;
  const stutterFrames = samples.filter(
    (sample) => sample.caption.length > 0 && STUTTER_FRAGMENT.test(visibleOverlayText(sample)),
  );

  const latencies: number[] = [];
  const latencyDetails: string[] = [];
  for (const chunk of asr.chunks) {
    if (chunk.sound || chunk.expected.length === 0) continue;
    const seenAt = samples.find(
      (sample, index) =>
        sample.nativeText === chunk.native &&
        (index === 0 || samples[index - 1]?.nativeText !== chunk.native),
    )?.atMs;
    if (seenAt === undefined) {
      latencies.push(Number.POSITIVE_INFINITY);
      latencyDetails.push(chunk.native + '=missing-native');
      continue;
    }
    const shown = samples.find(
      (sample) => sample.atMs >= seenAt && sample.caption === chunk.expected,
    );
    const latency = shown ? Math.max(0, shown.atMs - seenAt) : Number.POSITIVE_INFINITY;
    latencies.push(latency);
    latencyDetails.push(chunk.native + '=' + Math.round(latency));
  }
  const worstLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

  const metrics: MetricResult[] = [
    metric(
      'marker-leak frames',
      markerLeaks.length,
      0,
      'frames',
      markerLeaks.length === 0,
      'frames showing S1/ED/E/T/NC/RS in caption attributes: ' +
        JSON.stringify([...new Set(markerLeaks.map((sample) => sample.caption))].slice(0, 6)),
    ),
    metric(
      'sound-tag-translations',
      soundTagTranslations + soundTagFrames,
      0,
      'calls+frames',
      soundTagTranslations === 0 && soundTagFrames === 0,
      'fake-engine sound-tag model calls=' +
        String(soundTagTranslations) +
        ', overlay sound-tag frames (caption+original)=' +
        String(soundTagFrames),
    ),
    metric(
      'stutter-english-leftover',
      stutterFrames.length,
      0,
      'frames',
      stutterFrames.length === 0,
      'frames with repeated English words in the Japanese overlay: ' +
        JSON.stringify([...new Set(stutterFrames.map((sample) => sample.caption))].slice(0, 6)),
    ),
    metric(
      'asr-show-latency: worst',
      Math.round(worstLatency),
      THRESHOLDS.asrShowLatencyMs,
      'ms',
      worstLatency <= THRESHOLDS.asrShowLatencyMs,
      'per-native-chunk ms from first native paint: ' + latencyDetails.join(', '),
    ),
  ];
  return {
    language: 'en',
    sampleCount: samples.length,
    sentencesSeen: [],
    unexpectedStrings: [],
    metrics,
    failures: metrics
      .filter((entry) => !entry.passed)
      .map((entry) => entry.name + ': ' + entry.value + ' ' + entry.unit + ' > ' + entry.threshold),
  };
}
