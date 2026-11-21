import type { Window as HappyDomWindow } from 'happy-dom';
import { readYoutubeCaptionDom } from './youtube';
import type { PageEngine } from '../dom/session';
import { replayOriginalGeometry } from './replay-geometry';

/** A full native-caption snapshot. Successive events commonly add one ASR word. */
export interface CaptionTraceEvent {
  atMs: number;
  text: string;
}

export interface CaptionTrace {
  version: 1;
  name: string;
  sourceLanguage: string;
  targetLanguage: string;
  videoId: string;
  endMs: number;
  events: readonly CaptionTraceEvent[];
}

export interface CaptionReplayFrame {
  atMs: number;
  active: boolean;
  visible: boolean;
  pending: boolean;
  source: string;
  original: string;
  translation: string;
  width: number;
  height: number;
  originalLeft: number;
  originalLineCount: number;
  originalFirstVisibleLine: number;
  originalVisibleText: string;
  originalRollUp: boolean;
  originalClippedChars: number;
}

export interface CaptionTranslationRequest {
  atMs: number;
  input: string;
  inputLength: number;
  completed: boolean;
  cancelled: boolean;
  completedAtMs: number | null;
}

export interface CaptionReplayMetrics {
  frameCount: number;
  activeFrameCount: number;
  blankTranslationFrameCount: number;
  blankTranslationPercentage: number;
  blankTranslationFramesAfterFirst: number;
  widthChangeCount: number;
  heightChangeCount: number;
  originalHorizontalShiftCount: number;
  originalRollUpCount: number;
  clippedOriginalCharCount: number;
  maxClippedOriginalCharCount: number;
  committedSentenceCount: number;
  committedSentenceRewriteCount: number;
  maxTranslationsPerCommittedSentence: number;
  completedTranslationFrameCount: number;
  translationOriginalMappingCount: number;
  translationOriginalMismatchCount: number;
  translationDwellMs: number[];
  minTranslationDwellMs: number | null;
  medianTranslationDwellMs: number | null;
  translationInputLengths: number[];
  cancellationCount: number;
}

export interface CaptionReplayResult {
  trace: string;
  sourceLanguage: string;
  targetLanguage: string;
  latencyMs: number;
  frames: CaptionReplayFrame[];
  translationRequests: CaptionTranslationRequest[];
  metrics: CaptionReplayMetrics;
}

export interface CaptionReplayOptions {
  latencyMs: 150 | 400 | 900;
  frameIntervalMs?: number;
  tailMs?: number;
}

export const CAPTION_REPLAY_FRAME_MS = 100;
export const CAPTION_REPLAY_MIN_DWELL_MS = 400;
export const CAPTION_REPLAY_LATENCIES_MS = [150, 400, 900] as const;

const LABELS = {
  label: 'Translated captions',
  pending: 'Translating caption…',
  showOriginal: 'Show original caption',
  hideOriginal: 'Hide original caption',
  braveShields: 'Caption data is unavailable.',
};

interface ReplayTimer {
  at: number;
  every: number | null;
  callback: () => void;
}

/** A virtual clock shared by session timers and the fake translator. */
class ReplayClock {
  time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, ReplayTimer>();

  readonly setTimeout = (callback: () => void, delay = 0): number => {
    return this.add(callback, delay, null);
  };

  readonly setInterval = (callback: () => void, delay = 1): number => {
    return this.add(callback, delay, Math.max(1, delay));
  };

  readonly clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  readonly clearInterval = (id: number): void => {
    this.timers.delete(id);
  };

  readonly requestAnimationFrame = (callback: FrameRequestCallback): number => {
    return this.setTimeout(() => callback(this.time), 16);
  };

  readonly cancelAnimationFrame = (id: number): void => {
    this.clearTimeout(id);
  };

  private add(callback: () => void, delay: number, every: number | null): number {
    const id = this.nextId;
    this.nextId += 1;
    const wait = Number.isFinite(delay) ? Math.max(0, delay) : 0;
    this.timers.set(id, { at: this.time + wait, every, callback });
    return id;
  }

  async advanceTo(target: number): Promise<void> {
    for (;;) {
      let selectedId: number | null = null;
      let selected: ReplayTimer | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue;
        if (
          !selected ||
          timer.at < selected.at ||
          (timer.at === selected.at && id < (selectedId ?? 0))
        ) {
          selectedId = id;
          selected = timer;
        }
      }
      if (selectedId === null || !selected) break;
      this.time = Math.max(this.time, selected.at);
      if (selected.every === null) this.timers.delete(selectedId);
      else selected.at = this.time + selected.every;
      selected.callback();
      await flushMicrotasks();
    }
    this.time = Math.max(this.time, target);
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  // Session setup and MutationObserver delivery cross several promise jobs.
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

/**
 * Replay a local snapshot file through the real VideoCaptionSession.
 * No fetch, player response, timedtext read, or video resource leaves this harness.
 */
export async function replayCaptionTrace(
  input: CaptionTrace,
  options: CaptionReplayOptions,
): Promise<CaptionReplayResult> {
  const trace = validateCaptionTrace(input);
  const [{ Window }, { VideoCaptionSession }] = await Promise.all([
    import('happy-dom'),
    import('./session'),
  ]);
  const view = new Window({ url: `https://www.youtube.com/watch?v=${trace.videoId}` });
  const clock = new ReplayClock();
  const restoreGlobals = installReplayGlobals(view);
  const restoreTimers = installReplayTimers(view, clock);
  const requests: CaptionTranslationRequest[] = [];
  const frames: CaptionReplayFrame[] = [];
  let session: InstanceType<typeof VideoCaptionSession> | null = null;

  try {
    view.document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player ytp-live">
        <video id="player" class="html5-main-video"></video>
        <div class="ytp-caption-window-container" lang="${trace.sourceLanguage}">
          <span class="ytp-caption-segment"></span>
        </div>
      </div>`;
    const video = view.document.querySelector('video') as unknown as HTMLVideoElement;
    const segment = view.document.querySelector('.ytp-caption-segment') as unknown as HTMLElement;
    const player = view.document.getElementById('movie_player') as unknown as HTMLElement;
    const media = { currentTime: 0 };
    stubVideo(video, media, trace.endMs + (options.tailMs ?? 1_500));
    stubRect(video, 640, 360);
    stubRect(player, 640, 360);

    const engine = fakeTranslator(clock, trace.targetLanguage, options.latencyMs, requests);
    session = new VideoCaptionSession(view.document as unknown as Document, {
      engine,
      labels: LABELS,
      preferences: {
        enabled: true,
        targetLanguage: trace.targetLanguage,
        form: 'polite',
        display: 'bilingual',
        tier: 'g',
      },
      now: () => clock.time,
      readPlayerResponse: async () => syntheticPlayerResponse(trace),
      readTrack: async () => '',
      readBrave: async () => false,
    });
    session.start();
    await flushMicrotasks();

    const host = view.document.querySelector('sakutto-captions') as HTMLElement | null;
    if (host) stubCaptionRect(host);
    const frameMs = options.frameIntervalMs ?? CAPTION_REPLAY_FRAME_MS;
    if (!Number.isInteger(frameMs) || frameMs <= 0)
      throw new Error('frameIntervalMs must be positive');
    const endMs = trace.endMs + (options.tailMs ?? 1_500);
    let eventIndex = 0;
    let source = '';
    let previousOriginal: { text: string; firstVisibleLine: number } | null = null;

    for (let atMs = 0; atMs <= endMs; atMs += frameMs) {
      media.currentTime = atMs / 1_000;
      await clock.advanceTo(atMs);
      while (
        eventIndex < trace.events.length &&
        (trace.events[eventIndex]?.atMs ?? Infinity) <= atMs
      ) {
        source = trace.events[eventIndex]?.text ?? '';
        eventIndex += 1;
      }
      const nextSource = segment.textContent ?? '';
      if (source !== nextSource) {
        segment.textContent = source;
        video.dispatchEvent(new view.Event('timeupdate', { bubbles: true }) as unknown as Event);
        await flushMicrotasks();
      }
      const currentHost = view.document.querySelector('sakutto-captions') as HTMLElement | null;
      if (currentHost && !currentHost.getBoundingClientRect().width && !currentHost.hidden) {
        // The host is attached during the first asynchronous session sync.
        stubCaptionRect(currentHost);
      }
      const rect = currentHost?.getBoundingClientRect();
      const original = currentHost?.getAttribute('data-sakutto-original') ?? '';
      const originalGeometry = replayOriginalGeometry(original);
      const continuingOriginal =
        previousOriginal !== null &&
        original.length > 0 &&
        (original.startsWith(previousOriginal.text) || previousOriginal.text.startsWith(original));
      const originalRollUp = Boolean(
        continuingOriginal &&
        previousOriginal &&
        originalGeometry.firstVisibleLine > previousOriginal.firstVisibleLine,
      );
      frames.push({
        atMs,
        active: source.trim().length > 0,
        visible: Boolean(currentHost && !currentHost.hidden),
        pending: currentHost?.hasAttribute('data-sakutto-pending') ?? false,
        source,
        original,
        translation: currentHost?.getAttribute('data-sakutto-caption') ?? '',
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        originalLeft: originalGeometry.left,
        originalLineCount: originalGeometry.lineCount,
        originalFirstVisibleLine: originalGeometry.firstVisibleLine,
        originalVisibleText: originalGeometry.visibleText,
        originalRollUp,
        originalClippedChars: originalGeometry.clippedChars,
      });
      previousOriginal = original
        ? { text: original, firstVisibleLine: originalGeometry.firstVisibleLine }
        : null;
    }
    session.stop();
    session = null;
    await flushMicrotasks();
    return {
      trace: trace.name,
      sourceLanguage: trace.sourceLanguage,
      targetLanguage: trace.targetLanguage,
      latencyMs: options.latencyMs,
      frames,
      translationRequests: requests,
      metrics: replayMetrics(frames, requests),
    };
  } finally {
    session?.stop();
    restoreTimers();
    restoreGlobals();
    await view.happyDOM.close();
  }
}

function fakeTranslator(
  clock: ReplayClock,
  targetLanguage: string,
  latencyMs: number,
  requests: CaptionTranslationRequest[],
): PageEngine {
  return {
    async *translate(segments, options) {
      const signal = options.signal;
      for (const segment of segments) {
        const request: CaptionTranslationRequest = {
          atMs: clock.time,
          input: segment.text,
          inputLength: segment.text.length,
          completed: false,
          cancelled: false,
          completedAtMs: null,
        };
        requests.push(request);
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (cancelled: boolean): void => {
            if (settled) return;
            settled = true;
            request.cancelled = cancelled;
            signal?.removeEventListener('abort', onAbort);
            resolve();
          };
          const onAbort = (): void => finish(true);
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) {
            finish(true);
            return;
          }
          clock.setTimeout(() => {
            request.completed = true;
            request.completedAtMs = clock.time;
            finish(false);
          }, latencyMs);
        });
        if (request.cancelled || signal?.aborted) continue;
        const prefix = targetLanguage.toLowerCase().startsWith('ja') ? '訳' : 'EN';
        yield { id: segment.id, final: `${prefix}[${segment.text}]`, engine: 'plamo' };
      }
    },
  };
}

function syntheticPlayerResponse(trace: CaptionTrace): unknown {
  return {
    videoDetails: { videoId: trace.videoId, isLive: true },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: `https://offline.invalid/${encodeURIComponent(trace.videoId)}`,
            languageCode: trace.sourceLanguage,
            kind: 'asr',
            name: { simpleText: `Synthetic ${trace.sourceLanguage} ASR` },
          },
        ],
      },
    },
  };
}

function stubVideo(
  video: HTMLVideoElement,
  media: { currentTime: number },
  durationMs: number,
): void {
  const values: Record<string, unknown> = {
    paused: false,
    ended: false,
    readyState: 4,
    muted: true,
    volume: 1,
    duration: durationMs / 1_000,
    videoWidth: 640,
    videoHeight: 360,
    playbackRate: 1,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(video, key, { configurable: true, get: () => value });
  }
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => media.currentTime,
    set: (value: number) => {
      media.currentTime = value;
    },
  });
}

function stubRect(element: Element, width: number, height: number): void {
  element.getBoundingClientRect = () => rect(0, 0, width, height);
}

/** Fixed two-row live geometry makes layout changes observable without a browser layout engine. */
function stubCaptionRect(host: HTMLElement): void {
  host.getBoundingClientRect = () => {
    if (host.hidden) return rect(0, 0, 0, 0);
    if (host.hasAttribute('data-sakutto-live')) return rect(32, 244, 576, 72);
    const translated = host.hasAttribute('data-sakutto-caption');
    return rect(80, translated ? 252 : 284, 480, translated ? 64 : 32);
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function installReplayTimers(view: HappyDomWindow, clock: ReplayClock): () => void {
  const target = view as unknown as Record<string, unknown>;
  const keys = [
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const;
  const previous = new Map<string, unknown>();
  for (const key of keys) {
    previous.set(key, target[key]);
    target[key] = clock[key];
  }
  return () => {
    for (const key of keys) target[key] = previous.get(key);
  };
}

function installReplayGlobals(view: HappyDomWindow): () => void {
  const browser = view as unknown as Record<string, unknown>;
  const keys = [
    'window',
    'document',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLVideoElement',
    'Event',
    'MouseEvent',
    'MutationObserver',
    'ResizeObserver',
    'DOMRect',
    'getComputedStyle',
  ] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === 'window' ? view : browser[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return () => {
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

export function replayMetrics(
  frames: readonly CaptionReplayFrame[],
  requests: readonly CaptionTranslationRequest[],
): CaptionReplayMetrics {
  const active = frames.filter((frame) => frame.active);
  const blank = active.filter((frame) => frame.translation.trim().length === 0);
  const firstTranslation = frames.findIndex(
    (frame) => frame.active && frame.translation.trim().length > 0,
  );
  const blankAfterFirst =
    firstTranslation < 0
      ? 0
      : frames
          .slice(firstTranslation + 1)
          .filter((frame) => frame.active && frame.translation.trim().length === 0).length;
  const dwells: number[] = [];
  let dwellStart = -1;
  let dwellTranslation = '';
  for (let index = 0; index <= frames.length; index += 1) {
    const frame = frames[index];
    const translation = frame?.visible ? frame.translation.trim() : '';
    if (translation && translation === dwellTranslation) continue;
    if (dwellTranslation && dwellStart >= 0) {
      dwells.push((frame?.atMs ?? frames.at(-1)?.atMs ?? 0) - dwellStart);
    }
    dwellTranslation = translation;
    dwellStart = translation ? (frame?.atMs ?? -1) : -1;
  }
  const dimensions = frames.filter((frame) => frame.active && frame.visible);
  let widthChangeCount = 0;
  let heightChangeCount = 0;
  let originalHorizontalShiftCount = 0;
  for (let index = 1; index < dimensions.length; index += 1) {
    const previous = dimensions[index - 1];
    const current = dimensions[index];
    if (!previous || !current) continue;
    if (previous.width !== current.width) widthChangeCount += 1;
    if (previous.height !== current.height) {
      const firstTranslationArrival =
        previous.translation.trim().length === 0 && current.translation.trim().length > 0;
      if (!firstTranslationArrival) heightChangeCount += 1;
    }
    if (
      previous.original &&
      current.original &&
      previous.originalLeft !== current.originalLeft &&
      !current.originalRollUp
    ) {
      originalHorizontalShiftCount += 1;
    }
  }
  const completedFrames = dimensions.filter(
    (frame) => !frame.pending && frame.translation.trim().length > 0,
  );
  const committedTranslations = new Map<string, Set<string>>();
  let translationOriginalMappingCount = 0;
  for (const frame of completedFrames) {
    const request = requests.find(
      (candidate) =>
        candidate.completed &&
        (candidate.completedAtMs ?? Infinity) <= frame.atMs &&
        isFakeTranslation(frame.translation, candidate.input) &&
        frame.original.includes(candidate.input),
    );
    if (!request) continue;
    translationOriginalMappingCount += 1;
    for (const sentence of committedSourceSentences(request.input)) {
      const translations = committedTranslations.get(sentence) ?? new Set<string>();
      translations.add(frame.translation);
      committedTranslations.set(sentence, translations);
    }
  }
  const translationCounts = [...committedTranslations.values()].map((values) => values.size);
  return {
    frameCount: frames.length,
    activeFrameCount: active.length,
    blankTranslationFrameCount: blank.length,
    blankTranslationPercentage: active.length ? round((blank.length / active.length) * 100) : 0,
    blankTranslationFramesAfterFirst: blankAfterFirst,
    widthChangeCount,
    heightChangeCount,
    originalHorizontalShiftCount,
    originalRollUpCount: dimensions.filter((frame) => frame.originalRollUp).length,
    clippedOriginalCharCount: dimensions.reduce(
      (total, frame) => total + frame.originalClippedChars,
      0,
    ),
    maxClippedOriginalCharCount: Math.max(
      0,
      ...dimensions.map((frame) => frame.originalClippedChars),
    ),
    committedSentenceCount: committedTranslations.size,
    committedSentenceRewriteCount: translationCounts.reduce(
      (total, count) => total + Math.max(0, count - 1),
      0,
    ),
    maxTranslationsPerCommittedSentence: Math.max(0, ...translationCounts),
    completedTranslationFrameCount: completedFrames.length,
    translationOriginalMappingCount,
    translationOriginalMismatchCount: completedFrames.length - translationOriginalMappingCount,
    translationDwellMs: dwells,
    minTranslationDwellMs: dwells.length ? Math.min(...dwells) : null,
    medianTranslationDwellMs: median(dwells),
    translationInputLengths: requests.map((request) => request.inputLength),
    cancellationCount: requests.filter((request) => request.cancelled).length,
  };
}

function isFakeTranslation(translation: string, input: string): boolean {
  return translation === `訳[${input}]` || translation === `EN[${input}]`;
}

/** Sentence-final punctuation and the session's 96-character live commit threshold. */
function committedSourceSentences(input: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (!/[.!?。！？…]/u.test(input[index] ?? '')) continue;
    const sentence = input.slice(start, index + 1).trim();
    if (sentence) sentences.push(sentence);
    start = index + 1;
  }
  const tail = input.slice(start).trim();
  if (tail.length >= 96) sentences.push(tail);
  return sentences;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function validateCaptionTrace(value: unknown): CaptionTrace {
  if (!value || typeof value !== 'object') throw new Error('Caption trace must be an object');
  const trace = value as Partial<CaptionTrace>;
  if (trace.version !== 1) throw new Error('Caption trace version must be 1');
  for (const key of ['name', 'sourceLanguage', 'targetLanguage', 'videoId'] as const) {
    if (typeof trace[key] !== 'string' || trace[key].length === 0) {
      throw new Error(`Caption trace ${key} must be a non-empty string`);
    }
  }
  if (!Number.isFinite(trace.endMs) || (trace.endMs ?? -1) < 0) {
    throw new Error('Caption trace endMs must be a non-negative finite number');
  }
  if (!Array.isArray(trace.events)) throw new Error('Caption trace events must be an array');
  let previous = -1;
  for (const event of trace.events) {
    if (
      !event ||
      !Number.isFinite(event.atMs) ||
      event.atMs < previous ||
      typeof event.text !== 'string'
    ) {
      throw new Error('Caption trace events must be ordered { atMs, text } snapshots');
    }
    previous = event.atMs;
  }
  return trace as CaptionTrace;
}

export interface CaptionTraceRecorderOptions {
  sourceLanguage: string;
  targetLanguage: string;
  name?: string;
  videoId?: string;
  now?: () => number;
}

export interface CaptionTraceRecorder {
  /** Stop observing and return the local, JSON-serializable trace. */
  stop: () => CaptionTrace;
}

/**
 * Development-only, opt-in DOM recorder. It performs no network I/O and is never installed
 * automatically. Local captures belong in the gitignored traces/ directory, not test fixtures.
 */
export function startCaptionTraceRecorder(
  doc: Document,
  options: CaptionTraceRecorderOptions,
): CaptionTraceRecorder {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const events: CaptionTraceEvent[] = [];
  let previous: string | null = null;
  const sample = (): void => {
    const text = readYoutubeCaptionDom(doc, {
      spokenLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
    });
    if (text === previous || (text.length === 0 && previous === null)) return;
    previous = text;
    events.push({ atMs: Math.max(0, Math.round(now() - started)), text });
  };
  const observer = new MutationObserver(sample);
  observer.observe(doc.documentElement, { childList: true, characterData: true, subtree: true });
  sample();
  return {
    stop: () => {
      observer.disconnect();
      sample();
      const at = Math.max(0, Math.round(now() - started));
      return {
        version: 1,
        name: options.name ?? 'local-caption-capture',
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        videoId: options.videoId ?? 'local-capture',
        endMs: Math.max(at, (events.at(-1)?.atMs ?? 0) + 1_000),
        events,
      };
    },
  };
}
