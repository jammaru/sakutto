import { pageHost } from '@/dom/sites';
import { AsrChunkStream, asrDeltaOptions } from './asr-stream';
import type { PageEngine } from '@/dom/session';
import type { GlossaryEntry } from '@/engine/types';
import { glossaryEquals } from '@/shared/glossary';
import { canonicalLanguage, isCjkTarget, isPlamoOnlyTarget } from '@/shared/languages';
import {
  VIDEO_CAPTION_SIZE_DEFAULT,
  type DisplayMode,
  type Formality,
  type VideoCaptionPosition,
} from '@/shared/settings';
import {
  buildSentenceUnitsFromTrack,
  cueAtTime,
  cuesFromPlayhead,
  cuesInWindow,
  finalizeCaptionCues,
  joinCaptionFragments,
  LIVE_CAPTION_MIN_DISPLAY_MS,
  normalizeCaptionText,
  parseWebVtt,
  type CaptionCue,
} from './cues';
import { parseVodJson3Timeline, type VodTimeline } from './vod-json3';
import { VodDisplayScheduler } from './vod-json3-display';
import { VodPrefetchController } from './vod-prefetch';
import {
  CAPTION_LIVE_PRIORITY,
  CAPTION_PLAYHEAD_PRIORITY,
  CAPTION_PREFETCH_MAX_CUES,
  captionPrefetchWindowMs,
  CaptionTranslator,
  type CaptionTranslateOptions,
} from './engine';
import {
  cuesFromTrack,
  listCaptionTracks,
  pickCaptionTrack,
  pickPlayingOrPrimaryVideo,
  pickPrimaryVideo,
  listVideoTrackUrls,
  revealTrackCues,
} from './html5';
import { hostMatchesCaptionCustom } from './custom-hosts';
import { readGenericCaptionDom } from './generic';
import {
  CAPTION_ORIGINAL_TOGGLE,
  CAPTION_OVERLAY_HOST,
  CaptionOverlay,
  captionChromeInset,
  CAPTION_LAYOUT_MIN_PX,
  captionOverlayFontPx,
  captionOverlayRoot,
  pickCaptionLayoutRect,
  type CaptionLayoutRect,
  type CaptionOverlayLabels,
} from './overlay';
import { readTimedtext, TimedtextFetchGuard } from './timedtext';
import { cleanCaptionSource, isBareSoundWord, isSoundTagOnly } from './text-cleanup';
import { captionDebug } from './debug';
import {
  isTwimgCaptionAssetUrl,
  isXHost,
  listXCaptionSourceUrls,
  listXSubtitleUrls,
  parseHlsMediaSegments,
  parseHlsSubtitleRenditions,
  pickPlayingXVideo,
  pickXSubtitleRendition,
  readXActiveCues,
  readXCaptionDom,
} from './x';
import {
  captionLanguagePrefix,
  captionSourceIsTargetLanguage,
  captionTracksFromPlayerResponse,
  isYouTubeHost,
  isYouTubeLiveDocument,
  nativeCaptionFontPx,
  parseTimedtextPayload,
  playerResponseForPage,
  playerResponseFromDocument,
  readYoutubeCaptionDom,
  selectCaptionTrack,
  selectLiveCaptionTrack,
  spokenLanguageFromPlayerResponse,
  stripTargetLanguageFromCaption,
  withTimedtextFormat,
  youtubeVideoId,
  YOUTUBE_CAPTION_WINDOW_SELECTOR,
} from './youtube';

export interface CaptionSessionPreferences {
  enabled: boolean;
  targetLanguage: string;
  form: Formality;
  display: DisplayMode;
  glossary?: readonly GlossaryEntry[] | undefined;
  tier: 'g' | 'c8' | 'c4' | 'c1' | null;
  size?: number | undefined;
  originalToggle?: boolean | undefined;
  position?: VideoCaptionPosition | null | undefined;
  customHosts?: readonly string[] | undefined;
}

/** Re-read an empty X timeline this often; stop after `X_EMPTY_TRACK_MAX_ATTEMPTS`. */
export const X_EMPTY_TRACK_POLL_MS = 2_500;
/** Give up polling an X video that never publishes captions. A new video resets the count. */
export const X_EMPTY_TRACK_MAX_ATTEMPTS = 6;
/**
 * Give up re-reading an empty YouTube player response after this many polls.
 * Generous relative to X because Brave can publish the `pot=` URL long after the page
 * loaded, and the per-URL fetch guard already caps the actual timedtext GETs.
 * Navigation, a track change, or a successful cue load restarts the budget.
 */
export const YOUTUBE_EMPTY_TRACK_MAX_ATTEMPTS = 24;
/**
 * Keep the last translated line this long after its cue ends, or after a live DOM
 * caption disappears. Bridges a short gap while the next line is still being
 * translated. Expiry applies only to real silence (no current cue / no on-screen
 * DOM caption), not while a line is still being spoken. 2s covers typical caption
 * gaps without leaving a finished line on screen through a long pause.
 */
export const CAPTION_HOLD_MAX_MS = 2_000;
/**
 * `timeupdate` fires only ~4x/second, which leaves a caption visibly stuck between cues.
 * Poll the playhead at frame-like cadence while playing so a cue change paints promptly.
 */
const CAPTION_PLAYHEAD_POLL_MS = 50;

export interface CaptionSessionOptions {
  engine: PageEngine;
  labels: CaptionOverlayLabels;
  preferences: CaptionSessionPreferences;
  readTrack?: (url: string) => Promise<string>;
  readPlayerResponse?: () => Promise<unknown>;
  now?: () => number;
  onDisplayToggle?: () => void;
  onPositionChange?: (point: VideoCaptionPosition) => void;
}

interface LoadedTrack {
  key: string;
  cues: CaptionCue[];
  source?: 'vod-json3' | 'cue-list' | 'live-incremental' | 'dom-fallback';
  timeline?: VodTimeline | undefined;
  language?: string | undefined;
  /** YouTube auto-generated track: translate each visible chunk as it grows. */
  asr?: boolean | undefined;
  restoreModes: Array<{ track: TextTrack; mode: TextTrackMode }>;
}

interface LiveTailJob {
  text: string;
  options: CaptionTranslateOptions;
  revision: number;
}

const LIVE_SENTENCE_GAP_MS = 900;
const LIVE_SENTENCE_MAX_CHARS = 96;
const LIVE_SENTENCE_END_RE = /[.!?。！？…]$/u;

const NATIVE_HIDE_STYLE = `
${YOUTUBE_CAPTION_WINDOW_SELECTOR} { visibility: hidden !important; }
video::cue,
video::cue(i),
video::cue(b) {
  visibility: hidden !important;
  color: transparent !important;
  background: transparent !important;
  text-shadow: none !important;
}
video::-webkit-media-text-track-display,
video::-webkit-media-text-track-container,
video::-webkit-media-text-track-background,
::-webkit-media-text-track-display,
::-webkit-media-text-track-container {
  display: none !important;
  visibility: hidden !important;
}
[data-testid="videoPlayer"] [aria-live="polite"]:not(${CAPTION_OVERLAY_HOST}),
[data-testid="videoComponent"] [aria-live="polite"]:not(${CAPTION_OVERLAY_HOST}) {
  visibility: hidden !important;
}
[data-testid="videoPlayer"] [style*="text-shadow"]:not(${CAPTION_OVERLAY_HOST}):not(button):not([role="button"]),
[data-testid="videoComponent"] [style*="text-shadow"]:not(${CAPTION_OVERLAY_HOST}):not(button):not([role="button"]) {
  visibility: hidden !important;
}
[data-sakutto-native-caption] {
  visibility: hidden !important;
}
`;

export class VideoCaptionSession {
  private readonly doc: Document;
  private readonly overlay: CaptionOverlay;
  private readonly translator: CaptionTranslator;
  private readonly readTrack: (url: string) => Promise<string>;
  private readonly readPlayerResponse: () => Promise<unknown>;
  private readonly now: () => number;
  private readonly timedtextGuard = new TimedtextFetchGuard();
  private readonly vodDisplay = new VodDisplayScheduler();
  private vodPrefetch: VodPrefetchController | null = null;
  private prefs: CaptionSessionPreferences;
  private running = false;
  private video: HTMLVideoElement | null = null;
  private loaded: LoadedTrack | null = null;
  private loadInFlight = false;
  private nativeStyle: HTMLStyleElement | null = null;
  private observer: MutationObserver | null = null;
  private playerObserver: MutationObserver | null = null;
  private ignorePlayerMutations = false;
  private liveTimer: number | null = null;
  private liveTrackTimer: number | null = null;
  private playheadTimer: number | null = null;
  private lastPaintPlayheadMs = -1;
  private liveMode = false;
  private useDomCaptions = false;
  private hold: {
    cueId: string;
    original: string;
    translation: string;
    shownAt: number;
    startMs: number;
    endMs: number;
    live?: boolean | undefined;
    pending?: boolean | undefined;
  } | null = null;
  private holdTimer: number | null = null;
  private liveSource = '';
  private liveUtterance = '';
  private liveCommittedSource = '';
  private liveLastChangeAt = 0;
  private liveTailJob: LiveTailJob | null = null;
  private liveTailRevision = 0;
  private liveCaptionVisible = false;
  /** Low-latency provisional translation of the currently visible ASR chunk. */
  private provisionalSource = '';
  private provisionalOptions: CaptionTranslateOptions | null = null;
  /** Incremental, ordered translation of rolling live ASR windows. */
  private asrStream: AsrChunkStream | null = null;
  private activeCueId = '';
  private lastPlayed: HTMLVideoElement | null = null;
  private sourceKey = '';
  private sourceToken = 0;
  private passthroughNative = false;
  private historyUnpatch: (() => void) | null = null;
  private lastLayout: CaptionLayoutRect | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private placeFrame: number | null = null;
  private boundTrackList: TextTrackList | null = null;
  private emptyTrackAttempts = 0;
  private youtubeEmptyTrackAttempts = 0;
  private placeSettleTimer: number | null = null;
  private seekPaintTimer: number | null = null;
  /** A seek's translation generation stays open from `seeking` until `seeked`. */
  private seekGenerationOpen = false;
  private lastSeekTimeMs = Number.NaN;

  constructor(doc: Document, options: CaptionSessionOptions) {
    this.doc = doc;
    this.prefs = options.preferences;
    this.readTrack = options.readTrack ?? readTimedtext;
    this.readPlayerResponse = options.readPlayerResponse ?? defaultReadPlayerResponse;
    this.now = options.now ?? (() => Date.now());
    this.translator = new CaptionTranslator(options.engine);
    this.overlay = new CaptionOverlay(doc, options.labels);
    this.overlay.setOnDisplayToggle(() => options.onDisplayToggle?.());
    this.overlay.setOnPositionChange((point) => options.onPositionChange?.(point));
    this.overlay.setOnShortClick(() => this.togglePlayback());
    this.overlay.setToggleEnabled(this.prefs.originalToggle !== false);
    this.overlay.setPosition(this.prefs.position ?? null);
  }

  setPreferences(preferences: CaptionSessionPreferences): void {
    const wasEnabled = this.prefs.enabled;
    const targetChanged = this.prefs.targetLanguage !== preferences.targetLanguage;
    const formalityChanged = this.prefs.form !== preferences.form;
    const glossaryChanged = !glossaryEquals(this.prefs.glossary, preferences.glossary);
    const displayChanged = this.prefs.display !== preferences.display;
    const sizeChanged =
      (this.prefs.size ?? VIDEO_CAPTION_SIZE_DEFAULT) !==
      (preferences.size ?? VIDEO_CAPTION_SIZE_DEFAULT);
    const toggleChanged =
      (this.prefs.originalToggle !== false) !== (preferences.originalToggle !== false);
    const positionChanged = !sameCaptionPosition(this.prefs.position, preferences.position);
    this.prefs = { ...preferences, tier: this.prefs.tier ?? preferences.tier };
    this.overlay.setToggleEnabled(this.prefs.originalToggle !== false);
    this.overlay.setPosition(this.prefs.position ?? null);
    if (!preferences.enabled) {
      this.stop();
      return;
    }
    if (!wasEnabled) {
      this.start();
      return;
    }
    if (targetChanged || formalityChanged || glossaryChanged) {
      // Cached tail text alone is not enough: its translation options define the
      // result. Restart the source so an old-form result can never be committed.
      this.resetCaptionSource();
      this.passthroughNative = false;
      void this.sync(true);
      return;
    }
    if (displayChanged || sizeChanged || positionChanged) {
      this.place();
      this.repaintHold();
    }
    if (toggleChanged) this.place();
    void this.sync(true);
  }

  setLabels(labels: CaptionOverlayLabels): void {
    this.overlay.setLabels(labels);
  }

  setTier(tier: 'g' | 'c8' | 'c4' | 'c1' | null): void {
    this.prefs = { ...this.prefs, tier };
  }

  start(): void {
    if (!this.prefs.enabled || this.running) return;
    this.running = true;
    const view = this.doc.defaultView;
    view?.addEventListener('timeupdate', this.onMedia, true);
    view?.addEventListener('seeking', this.onSeek, true);
    view?.addEventListener('seeked', this.onSeek, true);
    view?.addEventListener('ratechange', this.onRate, true);
    view?.addEventListener('loadedmetadata', this.onMedia, true);
    view?.addEventListener('play', this.onPlay, true);
    view?.addEventListener('playing', this.onPlay, true);
    view?.addEventListener('pause', this.onPlay, true);
    view?.addEventListener('resize', this.onPlace);
    view?.addEventListener('scroll', this.onPlace, true);
    this.listenForTracks(videoTracksOf(this.doc));
    this.doc.addEventListener('fullscreenchange', this.onPlace);
    this.doc.addEventListener('yt-navigate-start', this.onNavigate);
    this.doc.addEventListener('yt-navigate-finish', this.onNavigate);
    this.doc.addEventListener('yt-page-data-updated', this.onNavigate);
    view?.addEventListener('popstate', this.onNavigate);
    this.bindHistory();
    this.observer = new MutationObserver(() => {
      void this.sync(false);
    });
    this.observer.observe(this.doc.documentElement, { childList: true, subtree: true });
    this.liveTimer =
      view?.setInterval(() => {
        this.pollLive();
      }, 200) ?? null;
    this.playheadTimer =
      view?.setInterval(() => {
        this.onPlayheadTick();
      }, CAPTION_PLAYHEAD_POLL_MS) ?? null;
    this.liveTrackTimer =
      view?.setInterval(() => {
        if (!this.video) return;
        if (this.liveMode) {
          void this.refreshLiveTrack(this.video);
          return;
        }
        // Keep re-reading an empty YouTube player response after the old URL's fetch cap.
        // Brave can publish the pot= URL later; the guard inside loadYouTubeTrack still
        // prevents another GET for the exhausted URL. Bounded like the X path below so no
        // browser polls forever; navigation, a track change, or a cue load restarts it.
        if (
          !this.liveMode &&
          (this.loaded?.cues.length ?? 0) === 0 &&
          (isYouTubeHost(pageHost(this.doc.defaultView?.location.href ?? '') ?? '') ||
            this.doc.getElementById('movie_player') !== null)
        ) {
          if (this.youtubeEmptyTrackAttempts >= YOUTUBE_EMPTY_TRACK_MAX_ATTEMPTS) return;
          this.youtubeEmptyTrackAttempts += 1;
          void this.loadTrack(this.video);
          return;
        }
        if (this.isXPage() && (this.loaded?.cues.length ?? 0) === 0 && !this.passthroughNative) {
          if (this.emptyTrackAttempts >= X_EMPTY_TRACK_MAX_ATTEMPTS) return;
          this.emptyTrackAttempts += 1;
          void this.loadTrack(this.video);
        }
      }, X_EMPTY_TRACK_POLL_MS) ?? null;
    // Same full selection path as a target-language change: never skip the first attach.
    this.resetCaptionSource();
    void this.sync(true);
  }

  stop(): void {
    this.running = false;
    const view = this.doc.defaultView;
    view?.removeEventListener('timeupdate', this.onMedia, true);
    view?.removeEventListener('seeking', this.onSeek, true);
    view?.removeEventListener('seeked', this.onSeek, true);
    view?.removeEventListener('ratechange', this.onRate, true);
    view?.removeEventListener('loadedmetadata', this.onMedia, true);
    view?.removeEventListener('play', this.onPlay, true);
    view?.removeEventListener('playing', this.onPlay, true);
    view?.removeEventListener('pause', this.onPlay, true);
    view?.removeEventListener('resize', this.onPlace);
    view?.removeEventListener('scroll', this.onPlace, true);
    this.listenForTracks(null);
    this.doc.removeEventListener('fullscreenchange', this.onPlace);
    this.doc.removeEventListener('yt-navigate-start', this.onNavigate);
    this.doc.removeEventListener('yt-navigate-finish', this.onNavigate);
    this.doc.removeEventListener('yt-page-data-updated', this.onNavigate);
    view?.removeEventListener('popstate', this.onNavigate);
    this.historyUnpatch?.();
    this.historyUnpatch = null;
    this.observer?.disconnect();
    this.observer = null;
    this.playerObserver?.disconnect();
    this.playerObserver = null;
    this.disconnectLayout();
    if (this.liveTimer !== null) {
      view?.clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
    if (this.liveTrackTimer !== null) {
      view?.clearInterval(this.liveTrackTimer);
      this.liveTrackTimer = null;
    }
    if (this.playheadTimer !== null) {
      view?.clearInterval(this.playheadTimer);
      this.playheadTimer = null;
    }
    this.lastPaintPlayheadMs = -1;
    this.seekGenerationOpen = false;
    this.lastSeekTimeMs = Number.NaN;
    this.liveMode = false;
    this.useDomCaptions = false;
    this.loadInFlight = false;
    this.timedtextGuard.reset();
    this.restoreTracks();
    this.hideNativeCaptions(false);
    this.resetLiveCaptions();
    this.vodPrefetch?.dispose();
    this.vodPrefetch = null;
    this.vodDisplay.reset([], 0);
    this.translator.clear();
    this.clearHold();
    this.unbindVideo(this.video);
    this.loaded = null;
    this.video = null;
    this.lastPlayed = null;
    this.sourceKey = '';
    this.sourceToken += 1;
    this.passthroughNative = false;
    this.lastLayout = null;
    this.doc.documentElement.removeAttribute('data-sakutto-captions');
    this.overlay.hide();
    this.overlay.detach();
  }

  private readonly onMedia = (): void => {
    void this.sync(false);
  };

  /** Frame-like playhead sampling; `timeupdate` alone is too coarse for cue boundaries. */
  private readonly onPlayheadTick = (): void => {
    const video = this.video;
    if (!video || video.paused || video.ended) return;
    const timeMs = this.playheadMs();
    if (timeMs === this.lastPaintPlayheadMs) return;
    this.lastPaintPlayheadMs = timeMs;
    // Speech whose deadline has passed must not be translated after the playhead.
    this.asrStream?.tick(timeMs);
    void this.paint(false, true);
  };

  private readonly onPlay = (event: Event): void => {
    const target = event.target;
    if (isHtmlVideo(target)) this.lastPlayed = target;
    void this.sync(true);
  };

  /** Restart the short paint so the settled playhead selects its destination too. */
  private scheduleSeekPaint(): void {
    const view = this.doc.defaultView;
    if (this.seekPaintTimer !== null) view?.clearTimeout(this.seekPaintTimer);
    this.seekPaintTimer =
      view?.setTimeout(() => {
        this.seekPaintTimer = null;
        void this.paint(true);
      }, 64) ?? null;
  }

  private readonly onSeek = (event: Event): void => {
    const timeMs = this.playheadMs();
    const settled = event.type === 'seeked';
    // Browsers fire `seeking` and `seeked` for one user seek, often more than the
    // 64 ms paint apart. Keep a single translator generation open for both: calling
    // translator.seek() again on `seeked` would abort the destination cue that the
    // paint already submitted and leave it terminally failed. Bare `seeked` events
    // (and an unchanged duplicate) still start or settle exactly one generation.
    if (settled && (this.seekGenerationOpen || timeMs === this.lastSeekTimeMs)) {
      this.seekGenerationOpen = false;
      this.lastSeekTimeMs = timeMs;
      this.scheduleSeekPaint();
      return;
    }
    this.seekGenerationOpen = !settled;
    this.lastSeekTimeMs = timeMs;
    this.resetLiveCaptions();
    this.clearHold();
    this.activeCueId = '';
    // Abort stale work before the VOD scheduler starts warming the new playhead.
    this.translator.seek();
    if (this.loaded?.source === 'vod-json3') {
      this.vodDisplay.seek(timeMs);
      this.vodPrefetch?.seek(timeMs, this.video?.playbackRate ?? 1);
    }
    // A jump before the held line (loop, ad, rewind) must not keep a future
    // translation. Do not showNative here: a seek must not flash native while
    // the new playhead cue is still translating.
    if (this.hold && timeMs < this.hold.startMs) this.clearHold();
    captionDebug('seek', {
      timeMs,
      hold: this.hold?.cueId ?? '',
    });
    this.scheduleSeekPaint();
  };

  private readonly onRate = (): void => {
    if (this.vodPrefetch) {
      this.vodPrefetch.setPlaybackRate(this.video?.playbackRate ?? 1, this.playheadMs());
      return;
    }
    this.prefetchFromPlayhead();
  };

  private readonly onPlace = (): void => {
    this.schedulePlace();
  };

  private readonly onNavigate = (): void => {
    this.resetCaptionSource();
    this.sourceKey = '';
    void this.sync(true);
  };

  private readonly onMediaSource = (): void => {
    void this.sync(true);
  };

  /** YouTube autoplay-next / SPA uses pushState; popstate does not fire. */
  private bindHistory(): void {
    const view = this.doc.defaultView;
    const history = view?.history;
    if (!view || !history || this.historyUnpatch) return;
    const pushState = history.pushState;
    const replaceState = history.replaceState;
    const onChange = (): void => {
      if (!this.running) return;
      const nextKey = captionSourceKey(this.doc, this.video ?? this.pickSessionVideo());
      if (nextKey === this.sourceKey) return;
      this.onNavigate();
    };
    history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
      pushState.apply(this, args);
      onChange();
    };
    history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
      replaceState.apply(this, args);
      onChange();
    };
    this.historyUnpatch = () => {
      history.pushState = pushState;
      history.replaceState = replaceState;
    };
  }

  private async sync(forceLoad: boolean): Promise<void> {
    if (!this.running || !this.prefs.enabled) return;
    const video = this.pickSessionVideo();
    const nextKey = captionSourceKey(this.doc, video);
    if (video !== this.video || nextKey !== this.sourceKey) {
      this.resetCaptionSource();
      this.unbindVideo(this.video);
      this.video = video;
      this.sourceKey = nextKey;
      this.bindVideo(video);
    }
    if (!video) {
      this.overlay.hide();
      this.overlay.detach();
      return;
    }
    this.overlay.attach(captionOverlayRoot(this.doc, video));
    this.place();
    if (forceLoad || !this.loaded) {
      await this.loadTrack(video);
    }
    await this.paint(false);
  }

  /**
   * Drop the previous video immediately: overlay, in-flight work, cue timeline, cache.
   * A later `paintCue` / `commitDisplay` from the old source is ignored via `sourceToken`.
   */
  private resetCaptionSource(): void {
    this.sourceToken += 1;
    this.loadInFlight = false;
    this.restoreTracks();
    this.loaded = null;
    this.useDomCaptions = false;
    this.liveMode = false;
    this.timedtextGuard.reset();
    this.resetLiveCaptions();
    this.vodPrefetch?.dispose();
    this.vodPrefetch = null;
    this.vodDisplay.reset([], 0);
    this.translator.clear();
    this.clearHold();
    this.activeCueId = '';
    this.passthroughNative = false;
    this.lastLayout = null;
    this.emptyTrackAttempts = 0;
    this.youtubeEmptyTrackAttempts = 0;
    this.seekGenerationOpen = false;
    this.lastSeekTimeMs = Number.NaN;
    this.overlay.hide();
  }

  private async loadTrack(video: HTMLVideoElement): Promise<void> {
    if (this.loadInFlight) return;
    const token = this.sourceToken;
    const key = trackKey(this.doc, video);
    if (this.loaded?.key === key && (this.loaded.cues.length > 0 || this.passthroughNative)) {
      this.applyNativeVisibility();
      return;
    }
    this.loadInFlight = true;
    try {
      // A key change that skipped resetCaptionSource still restarts the YouTube poll budget.
      if (this.loaded && this.loaded.key !== key) this.youtubeEmptyTrackAttempts = 0;
      const host = pageHost(this.doc.defaultView?.location.href ?? '') ?? '';
      const youtube = await this.loadYouTubeTrack();
      if (token !== this.sourceToken) return;
      if (youtube) {
        this.liveMode = youtube.live;
        this.finishLoadedTrack({ key, ...youtube, restoreModes: [] });
        this.warmAsrTrack();
        return;
      }
      this.liveMode = false;
      if (isYouTubeHost(host)) {
        this.finishLoadedTrack({ key, cues: [], restoreModes: [] });
        return;
      }

      if (isXHost(host)) {
        const xTrack = await this.loadXTrack(video);
        if (token !== this.sourceToken) return;
        const cueCount = xTrack?.cues.length ?? 0;
        this.useDomCaptions = cueCount === 0;
        captionDebug('x-load', {
          currentSrc: video.currentSrc || video.src || '',
          cueCount,
          language: xTrack?.language ?? '',
          useDomCaptions: this.useDomCaptions,
          readyState: video.readyState,
        });
        this.finishLoadedTrack(xTrack ? { key, ...xTrack } : { key, cues: [], restoreModes: [] });
        return;
      }

      const durationMs = Number.isFinite(video.duration) ? video.duration * 1000 : undefined;
      const html5 = loadHtml5Track(video, this.prefs.targetLanguage, durationMs);
      if (token !== this.sourceToken) return;
      if (html5 && html5.cues.length > 0) {
        this.finishLoadedTrack({ key, ...html5 });
        return;
      }
      const fromSrc = await this.loadTrackUrls(video, html5, durationMs);
      if (token !== this.sourceToken) return;
      this.loaded = fromSrc
        ? { key, ...fromSrc }
        : html5
          ? { key, ...html5 }
          : { key, cues: [], restoreModes: [] };
      this.useDomCaptions = (this.loaded.cues.length ?? 0) === 0 && this.allowsGenericDom();
      this.finishLoadedTrack(this.loaded);
    } finally {
      if (token === this.sourceToken) this.loadInFlight = false;
    }
  }

  private async loadYouTubeTrack(): Promise<
    (Omit<LoadedTrack, 'key' | 'restoreModes'> & { live: boolean }) | null
  > {
    const token = this.sourceToken;
    const stillCurrent = (): boolean => token === this.sourceToken;
    const live = isYouTubeLiveDocument(this.doc);
    const liveResponse = playerResponseForPage(
      this.doc,
      await this.readPlayerResponse().catch(() => null),
    );
    if (!stillCurrent()) return null;
    const documentResponse = playerResponseForPage(this.doc, playerResponseFromDocument(this.doc));
    const response =
      captionTracksFromPlayerResponse(liveResponse).length > 0
        ? liveResponse
        : (documentResponse ?? liveResponse);
    const tracks = captionTracksFromPlayerResponse(response);
    if (tracks.length === 0 && !live) return null;
    const spoken = spokenLanguageFromPlayerResponse(response);
    const selected = live
      ? selectLiveCaptionTrack(tracks, this.prefs.targetLanguage, spoken)
      : selectCaptionTrack(tracks, this.prefs.targetLanguage, spoken);
    if (!selected) return live ? { cues: [], live: true } : null;
    if (
      captionSourceIsTargetLanguage(selected.languageCode, undefined, this.prefs.targetLanguage)
    ) {
      this.useDomCaptions = false;
      return { cues: [], language: selected.languageCode, asr: selected.asr, live };
    }

    const fetchKey = `${youtubeVideoId(this.doc.defaultView?.location.href ?? '') ?? 'yt'}:${selected.baseUrl}`;
    if (!stillCurrent()) return null;
    if (!live) {
      const now = this.now();
      if (!this.timedtextGuard.allow(fetchKey, now) || !this.timedtextGuard.begin(fetchKey)) {
        return {
          cues: this.loaded?.cues ?? [],
          language: selected.languageCode,
          asr: selected.asr,
          live,
        };
      }
    }

    try {
      const loaded = await this.readYouTubeCues(
        selected.baseUrl,
        selected.languageCode,
        selected.asr,
        live,
      );
      const cues = loaded.cues;
      if (!stillCurrent()) {
        this.timedtextGuard.reset(fetchKey);
        return null;
      }
      if (cues.length > 0) {
        if (!live) this.timedtextGuard.succeed(fetchKey);
        this.useDomCaptions = live;
        return {
          cues,
          language: selected.languageCode,
          asr: selected.asr,
          live,
          source: live ? 'live-incremental' : loaded.timeline ? 'vod-json3' : 'cue-list',
          timeline: loaded.timeline,
        };
      }
      if (!live) this.timedtextGuard.fail(fetchKey, this.now());
      this.useDomCaptions = true;
      return { cues: [], language: selected.languageCode, asr: selected.asr, live };
    } catch {
      if (!stillCurrent()) {
        this.timedtextGuard.reset(fetchKey);
        return null;
      }
      if (!live) this.timedtextGuard.fail(fetchKey, this.now());
      this.useDomCaptions = true;
      return { cues: [], language: selected.languageCode, asr: selected.asr, live };
    }
  }

  private async refreshLiveTrack(video: HTMLVideoElement): Promise<void> {
    if (!this.running || !this.liveMode) return;
    const token = this.sourceToken;
    const youtube = await this.loadYouTubeTrack();
    if (!youtube || !this.running || token !== this.sourceToken) return;
    this.finishLoadedTrack({
      key: trackKey(this.doc, video),
      cues: youtube.cues,
      language: youtube.language,
      asr: youtube.asr,
      restoreModes: [],
    });
    this.warmAsrTrack();
  }

  private async loadXTrack(video: HTMLVideoElement): Promise<Omit<LoadedTrack, 'key'> | null> {
    const durationMs = Number.isFinite(video.duration) ? video.duration * 1000 : undefined;
    const html5 = loadHtml5Track(video, this.prefs.targetLanguage, durationMs, {
      mutateMode: false,
    });
    if (html5 && html5.cues.length > 0) {
      captionDebug('x-html5', { cueCount: html5.cues.length, language: html5.language ?? '' });
      return html5;
    }

    const urls = uniqueUrls([...listXSubtitleUrls(video), ...listXCaptionSourceUrls(video)]);
    captionDebug('x-urls', {
      currentSrc: video.currentSrc || '',
      src: video.src || '',
      urls,
    });
    const visited = new Set<string>();
    for (const url of urls) {
      const loaded = await this.loadXCaptionUrl(url, durationMs, visited);
      if (loaded && loaded.cues.length > 0) {
        captionDebug('x-vtt', {
          url,
          cueCount: loaded.cues.length,
          language: loaded.language ?? '',
        });
        return { ...loaded, restoreModes: html5?.restoreModes ?? [] };
      }
    }
    captionDebug('x-empty-timeline', {
      html5Language: html5?.language ?? '',
      urlCount: urls.length,
    });
    return html5;
  }

  private async loadXCaptionUrl(
    url: string,
    durationMs: number | undefined,
    visited: Set<string>,
    depth = 0,
  ): Promise<Omit<LoadedTrack, 'key'> | null> {
    if (depth > 4 || visited.has(url) || !isTwimgCaptionAssetUrl(url)) return null;
    visited.add(url);
    let body: string;
    try {
      body = await this.readTrack(url);
    } catch (error) {
      captionDebug('x-fetch', { url, error: String(error) });
      return null;
    }
    if (body.trim().length === 0) return null;
    if (body.trimStart().startsWith('WEBVTT')) {
      const cues = finalizeCaptionCues(parseWebVtt(body), durationMs);
      return cues.length > 0 ? { cues, restoreModes: [] } : null;
    }

    const renditions = parseHlsSubtitleRenditions(body, url);
    const selected = pickXSubtitleRendition(renditions, this.prefs.targetLanguage);
    if (selected) {
      const nested = await this.loadXCaptionUrl(selected.uri, durationMs, visited, depth + 1);
      if (nested && nested.cues.length > 0) {
        return { ...nested, language: nested.language ?? selected.language };
      }
    }

    const segments = parseHlsMediaSegments(body, url).slice(0, 40);
    if (segments.length === 0) return null;
    const cues: CaptionCue[] = [];
    let language: string | undefined;
    for (const segment of segments) {
      const nested = await this.loadXCaptionUrl(segment, durationMs, visited, depth + 1);
      if (!nested) continue;
      cues.push(...nested.cues);
      language = language ?? nested.language;
    }
    const finalized = finalizeCaptionCues(cues, durationMs);
    return finalized.length > 0 ? { cues: finalized, language, restoreModes: [] } : null;
  }

  private async loadTrackUrls(
    video: HTMLVideoElement,
    html5: Omit<LoadedTrack, 'key'> | null,
    durationMs?: number,
  ): Promise<Omit<LoadedTrack, 'key'> | null> {
    for (const url of listVideoTrackUrls(video)) {
      try {
        const body = await this.readTrack(url);
        const cues = finalizeCaptionCues(parseWebVtt(body), durationMs);
        if (cues.length > 0) {
          return { cues, restoreModes: html5?.restoreModes ?? [] };
        }
      } catch {
        // Try the next published track URL; never invent captions.
      }
    }
    return null;
  }

  private finishLoadedTrack(loaded: LoadedTrack): void {
    const resetVodDisplay =
      loaded.source === 'vod-json3' &&
      (this.loaded?.key !== loaded.key || this.loaded.source !== 'vod-json3');
    this.loaded = loaded;
    if (loaded.source === 'vod-json3' && resetVodDisplay) {
      const timeMs = this.playheadMs();
      this.vodDisplay.reset(loaded.cues, timeMs);
      this.vodPrefetch?.dispose();
      const sourceCues = loaded.cues.map((cue) => ({ ...cue, text: this.originalForCue(cue) }));
      this.vodPrefetch = new VodPrefetchController({
        cues: sourceCues,
        adapter: {
          getCached: (text, options) => {
            const cached = this.translator.getCached(text, options);
            if (cached !== undefined) {
              this.emitVodRequest('cache-hit', '', text, 'cache');
            }
            return cached;
          },
          translateCue: (cue, options, priority) => {
            const generation = this.translator.translateGeneration();
            this.emitVodRequest('start', cue.id, cue.text, 'translate', priority);
            return this.translator.translateCue(cue, options, priority).then((translated) => {
              const aborted = translated === null && this.translator.abortedSince(generation);
              this.emitVodRequest(
                'finish',
                cue.id,
                cue.text,
                aborted ? 'abort' : translated === null ? 'error' : 'complete',
                priority,
              );
              return aborted ? { aborted: true } : translated;
            });
          },
          cancelText: (text, options) => {
            this.emitVodRequest('abort', '', text, 'cancel');
            this.translator.cancelText(text, options);
          },
        },
        options: { ...this.translateOptions(loaded.language), preserveNumbers: true },
        timeMs,
        playbackRate: this.video?.playbackRate ?? 1,
        onDebug: (event) => {
          captionDebug('vod-prefetch', { ...event });
          this.doc.dispatchEvent(
            new CustomEvent('sakutto:vod-scheduler', {
              detail: { ...event, mode: 'vod-json3', at: this.now() },
            }),
          );
          if (
            (event.type === 'complete' || event.type === 'error') &&
            this.running &&
            this.loaded?.key === loaded.key
          ) {
            void this.paintVodJson3();
          }
        },
      });
    } else if (loaded.source !== 'vod-json3') {
      this.vodPrefetch?.dispose();
      this.vodPrefetch = null;
    }
    // Cues finally loaded: restart the empty-track poll budget in case the source empties again.
    if ((loaded.cues.length ?? 0) > 0) this.youtubeEmptyTrackAttempts = 0;
    this.passthroughNative = this.sourceMatchesTarget();
    if (this.passthroughNative) this.useDomCaptions = false;
    this.applyNativeVisibility();
    if (this.passthroughNative) {
      this.overlay.hide();
      return;
    }
    if ((loaded.cues.length ?? 0) === 0 && !this.useDomCaptions && !this.liveMode) {
      this.overlay.hide();
    }
  }

  private sourceMatchesTarget(): boolean {
    const language = this.loaded?.language;
    const knownMismatch =
      Boolean(language) &&
      captionLanguagePrefix(language).length > 0 &&
      !captionSourceIsTargetLanguage(language, undefined, this.prefs.targetLanguage);
    // YouTube ja ASR → en must keep translating. An empty X ja track still defers to DOM.
    if (knownMismatch && (!this.isXPage() || (this.loaded?.cues.length ?? 0) > 0)) return false;
    const visible = this.readSourceCaptionDom();
    if (visible.length > 0) {
      if (captionSourceIsTargetLanguage(undefined, visible, this.prefs.targetLanguage)) return true;
      // X native English must win over an empty ja-language track.
      if (this.isXPage()) return false;
      return captionSourceIsTargetLanguage(
        this.loaded?.language,
        visible,
        this.prefs.targetLanguage,
      );
    }
    const sample = this.loaded?.cues.find((cue) => cue.text.trim().length > 0)?.text ?? '';
    if (sample.length > 0) {
      return captionSourceIsTargetLanguage(
        this.loaded?.language,
        sample,
        this.prefs.targetLanguage,
      );
    }
    // X: an empty ja-language track must not lock passthrough before native text exists.
    if (this.isXPage()) return false;
    return captionSourceIsTargetLanguage(
      this.loaded?.language,
      undefined,
      this.prefs.targetLanguage,
    );
  }

  private overlayShowingCaption(): boolean {
    if (this.passthroughNative || !this.hold) return false;
    if (this.hold.original.trim().length === 0) return false;
    return (
      this.hold.live === true ||
      this.hold.pending === true ||
      this.hold.translation.trim().length > 0
    );
  }

  private applyNativeVisibility(reason?: string): void {
    const mode = this.passthroughNative
      ? 'native'
      : this.overlayShowingCaption()
        ? 'overlay'
        : 'waiting';
    if (mode !== 'overlay') {
      captionDebug('native', {
        reason: reason ?? (this.passthroughNative ? 'passthrough' : 'waiting'),
        mode,
        language: this.loaded?.language ?? '',
        target: this.prefs.targetLanguage,
        hold: this.hold?.cueId ?? '',
        timeMs: Math.round((this.video?.currentTime || 0) * 1000),
        cueCount: this.loaded?.cues.length ?? 0,
      });
    }
    if (this.passthroughNative) {
      this.hideNativeCaptions(false);
      this.restoreTracks();
      this.clearNativeCaptionMasks();
      this.doc.documentElement.setAttribute('data-sakutto-captions', 'native');
      this.overlay.hide();
      return;
    }
    if (!this.overlayShowingCaption()) {
      this.hideNativeCaptions(false);
      this.restoreTracks();
      this.clearNativeCaptionMasks();
      this.doc.documentElement.setAttribute('data-sakutto-captions', 'waiting');
      return;
    }
    this.hideNativeCaptions(true);
    if (this.video && !this.isXPage()) hideShowingCaptionTracks(this.video);
    this.doc.documentElement.setAttribute('data-sakutto-captions', 'overlay');
  }

  /** Native YouTube/X captions only when the overlay has nothing for this playhead. */
  private showNative(reason: string): void {
    this.clearHold();
    this.ignorePlayerMutations = true;
    this.overlay.hide();
    this.applyNativeVisibility(reason);
    this.releasePlayerMutations();
  }

  private clearNativeCaptionMasks(): void {
    for (const node of this.doc.querySelectorAll('[data-sakutto-native-caption]')) {
      node.removeAttribute('data-sakutto-native-caption');
    }
  }

  private async paint(force: boolean, skipPlace = false): Promise<void> {
    if (!this.running) return;
    const token = this.sourceToken;
    const video = this.video;
    if (!video) return;
    if (this.passthroughNative) {
      this.applyNativeVisibility();
      this.overlay.hide();
      return;
    }
    if (!skipPlace) this.place();
    if (this.loaded && this.loaded.cues.length === 0 && this.allowsGenericDom()) {
      const html5 = loadHtml5Track(
        video,
        this.prefs.targetLanguage,
        Number.isFinite(video.duration) ? video.duration * 1000 : undefined,
      );
      if (html5 && html5.cues.length > 0) {
        this.loaded = { ...this.loaded, ...html5 };
        this.passthroughNative = this.sourceMatchesTarget();
        if (this.passthroughNative) {
          this.applyNativeVisibility();
          this.overlay.hide();
          return;
        }
      }
    }

    const timeMs = Math.round((video.currentTime || 0) * 1000);
    const cues = this.loaded?.cues ?? [];
    const cue = cueAtTime(cues, timeMs);
    if (this.liveMode) {
      if (this.readSourceCaptionDom().length > 0) {
        this.pollLive();
        return;
      }
      if (cue) {
        await this.paintCue(cue, force);
        return;
      }
      this.pollLive();
      this.prefetchFromPlayhead();
      if (token === this.sourceToken && !this.holdActiveAt(timeMs)) this.showNative('no-cue');
      return;
    }
    if (this.loaded?.source === 'vod-json3') {
      await this.paintVodJson3();
      return;
    }
    if (cue) {
      await this.paintCue(cue, force);
      return;
    }
    if (this.useDomCaptions || this.isXPage()) {
      const visible = this.readSourceCaptionDom();
      if (visible.length > 0) {
        captionDebug('x-dom-fallback', { visible, timeMs, cueCount: cues.length });
        this.pollLive(true);
        return;
      }
    }
    this.pollLive();
    this.prefetchFromPlayhead();
    if (token === this.sourceToken && !this.holdActiveAt(timeMs)) this.showNative('no-cue');
  }

  private originalForCue(cue: CaptionCue): string {
    const stripped = stripTargetLanguageFromCaption(cue.text, this.prefs.targetLanguage);
    return cleanCaptionSource(
      stripped.length > 0 ? stripped : cue.text.trim(),
      this.loaded?.asr === true,
    );
  }

  private emitVodRequest(
    type: 'start' | 'abort' | 'finish' | 'cache-hit',
    cueId: string,
    sourceText: string,
    reason: string,
    priority = 0,
  ): void {
    this.doc.dispatchEvent(
      new CustomEvent('sakutto:caption-request', {
        detail: {
          action: type,
          cueId,
          sourceText,
          generation: this.vodPrefetch?.getState().generation ?? 0,
          priority,
          mode: 'vod-json3',
          reason,
          at: this.now(),
        },
      }),
    );
  }

  /** One options/context identity for VOD warming, cache lookup, and paint. */
  private optionsForVodCue(cue: CaptionCue): CaptionTranslateOptions {
    const options = {
      ...this.translateOptions(cue.language ?? this.loaded?.language),
      preserveNumbers: true,
    };
    const cues = this.loaded?.cues ?? [];
    const index = cues.findIndex((candidate) => candidate.id === cue.id);
    const scheduled = this.vodPrefetch?.optionsForCue(index);
    if (scheduled) return scheduled;
    const previous = index > 0 ? cues[index - 1] : undefined;
    const context = previous ? this.originalForCue(previous) : '';
    return context ? { ...options, context } : options;
  }

  private readVodDisplay(cue: CaptionCue): { original: string; translation: string } | null {
    const original = this.originalForCue(cue);
    if (!original || this.vodPrefetch?.hasFailed(cue.id)) return null;
    const cached = this.translator.getCached(original, this.optionsForVodCue(cue));
    if (cached !== undefined) this.emitVodRequest('cache-hit', cue.id, original, 'paint');
    return { original, translation: cached ?? '' };
  }

  private async paintVodJson3(): Promise<void> {
    const video = this.video;
    const cues = this.loaded?.cues ?? [];
    if (!video || cues.length === 0 || this.passthroughNative) return;
    if (sameLanguage(this.loaded?.language, this.prefs.targetLanguage)) {
      this.passthroughNative = true;
      this.applyNativeVisibility('same-language');
      return;
    }
    const timeMs = this.playheadMs();
    this.vodPrefetch?.reconcile(timeMs, video.playbackRate);
    const command = this.vodDisplay.update(
      timeMs,
      this.now(),
      (cue) => this.readVodDisplay(cue),
      video.paused,
    );
    if (command?.type === 'show') {
      const { cue, original, translation, pending } = command.paint;
      this.activeCueId = cue.id;
      this.commitDisplay(cue.id, original, translation, cue.startMs, cue.endMs, 0, false, pending);
      return;
    }
    if (command?.type === 'clear') {
      this.showNative('vod-silence');
      return;
    }
    if (!this.hold && timeMs < (cues[0]?.startMs ?? 0)) this.showNative('no-cue');
  }

  private async paintCue(cue: CaptionCue, force: boolean): Promise<void> {
    if (this.passthroughNative) return;
    const token = this.sourceToken;
    const liveRevision = this.liveTailRevision;
    const language = cue.language ?? this.loaded?.language;
    const options = this.translateOptions(language);
    const stripped = stripTargetLanguageFromCaption(cue.text, this.prefs.targetLanguage);
    const original = cleanCaptionSource(
      stripped.length > 0 ? stripped : cue.text.trim(),
      this.loaded?.asr === true,
    );
    if (original.length === 0) {
      if (!this.holdActiveAt(this.playheadMs())) this.showNative('empty-source');
      return;
    }
    if (sameLanguage(language, this.prefs.targetLanguage)) {
      this.passthroughNative = true;
      this.applyNativeVisibility('same-language');
      return;
    }
    const cueChanged = this.activeCueId !== cue.id;
    if (cueChanged) {
      this.activeCueId = cue.id;
      this.retainAroundPlayhead(original, options);
    }

    const cached = this.translator.getCached(original, options);
    if (cueChanged && !cached) {
      // A new cue owns the original row immediately. Its translation is the only
      // translation allowed for this unit, so do not show the previous unit's text.
      this.commitDisplay(cue.id, original, '', cue.startMs, cue.endMs, 0, false, true);
    }
    if (cached) {
      this.commitDisplay(cue.id, original, cached, cue.startMs, cue.endMs, 0);
      this.scheduleAroundPlayhead(cue);
      return;
    }
    // The current original is already visible while its translation is in flight;
    // expiry is only for a real gap, not for an uncached cue.
    if (!this.hold) this.showNative('waiting-first');
    const generation = this.translator.translateGeneration();
    // Start this request before warming the next cues: the playhead keeps the
    // first slot, while the following line is already in flight on parallel tiers.
    const pendingTranslation = this.translator.translateCue(
      { ...cue, text: original },
      options,
      CAPTION_PLAYHEAD_PRIORITY,
    );
    this.scheduleAroundPlayhead(cue);
    const translated = await pendingTranslation;
    if (!this.running || token !== this.sourceToken) return;
    if (this.translator.abortedSince(generation)) return;
    if (this.liveCaptionVisible || liveRevision !== this.liveTailRevision) return;
    const timeMs = this.playheadMs();
    const current = cueAtTime(this.loaded?.cues ?? [], timeMs);
    if (current && current.id !== cue.id) return;
    if (translated) {
      if (!current && timeMs > cue.endMs + CAPTION_HOLD_MAX_MS) return;
      this.commitDisplay(cue.id, original, translated, cue.startMs, cue.endMs, 0);
    } else if (current) {
      this.showNative('translate-failed');
    } else if (!this.holdActiveAt(timeMs)) {
      this.showNative('translate-failed');
    } else {
      captionDebug('translate-failed', { cueId: cue.id, original, force });
    }
  }

  private pollLive(forceDom = false): void {
    if (!this.running) return;
    if (this.passthroughNative) {
      this.overlay.hide();
      return;
    }
    if (!forceDom && !this.liveMode && !this.useDomCaptions) return;
    const visible = this.readSourceCaptionDom();
    if (visible.length === 0) {
      if (!forceDom && !this.liveMode && (this.loaded?.cues.length ?? 0) > 0) return;
      this.clearLiveSource();
      return;
    }
    if (!forceDom && !this.liveMode && (this.loaded?.cues.length ?? 0) > 0) return;

    const sourceLanguage = (this.loaded?.cues.length ?? 0) > 0 ? this.loaded?.language : undefined;
    if (captionSourceIsTargetLanguage(sourceLanguage, visible, this.prefs.targetLanguage)) {
      this.passthroughNative = true;
      this.applyNativeVisibility('same-language-dom');
      this.overlay.hide();
      return;
    }
    this.observeLiveCaption(visible);
  }

  /** Paint each visible ASR chunk now; the completed sentence can refine it later. */
  private observeLiveCaption(visible: string): void {
    // Clean once here, before dedupe: the same normalised string is painted in the
    // overlay, used as the model source and used to key the translation cache.
    const text = dedupeLiveCaptionText(cleanCaptionSource(visible, this.loaded?.asr === true));
    if (text.length === 0) {
      this.clearLiveSource();
      return;
    }
    const now = this.now();
    const previousSource = this.liveSource;
    this.liveCaptionVisible = true;
    this.extendHold(this.playheadMs());
    if (this.liveMode && this.loaded?.asr === true) {
      // Rolling live ASR is streamed one stable delta at a time. Keeping the earlier
      // coverage avoids tail-only fragments and re-decoding the same growing prefix.
      this.liveSource = text;
      this.liveLastChangeAt = now;
      this.liveTailRevision += 1;
      this.clearHoldTimer();
      this.asrStream ??= this.createAsrStream();
      this.asrStream.observe(text);
      this.asrStream.tick(this.playheadMs());
      return;
    }
    if (text === previousSource) {
      if (now - this.liveLastChangeAt >= LIVE_SENTENCE_GAP_MS) {
        this.commitLiveSentence(
          this.translateOptions(this.liveMode ? this.loaded?.language : undefined),
        );
      }
      return;
    }

    if (this.liveUtterance.length === 0) {
      this.liveUtterance = text;
    } else if (
      previousSource &&
      (text.startsWith(previousSource) || previousSource.startsWith(text))
    ) {
      this.liveUtterance = appendLiveCaptionText(
        this.liveUtterance,
        text.slice(previousSource.length),
      );
    } else if (this.shouldCommitLiveSentence(now, text)) {
      this.commitLiveSentence(
        this.translateOptions(this.liveMode ? this.loaded?.language : undefined),
      );
      this.liveUtterance = text;
    } else {
      this.liveUtterance = appendLiveCaptionText(this.liveUtterance, text);
    }

    const utterance = this.liveUtterance;
    this.liveSource = text;
    this.liveLastChangeAt = now;
    this.liveTailRevision += 1;
    if (this.liveMode && this.loaded?.asr) {
      this.startProvisionalLiveTranslation(
        text,
        this.translateOptions(this.loaded?.language),
        this.liveTailRevision,
      );
    }
    this.clearHoldTimer();
    if (LIVE_SENTENCE_END_RE.test(utterance) || utterance.length >= LIVE_SENTENCE_MAX_CHARS) {
      this.commitLiveSentence(
        this.translateOptions(this.liveMode ? this.loaded?.language : undefined),
      );
    }
  }

  /** Build the caption-only incremental translator for a live ASR track. */
  private createAsrStream(): AsrChunkStream {
    return new AsrChunkStream({
      spaceDelimited: () => !isCjkTarget(this.prefs.targetLanguage),
      now: () => this.now(),
      playheadMs: () => this.playheadMs(),
      translate: async (delta, context, sequence) => {
        const options = asrDeltaOptions(this.translateOptions(this.loaded?.language), context);
        return this.translator.translateCue(
          {
            id: `asr:${String(sequence)}`,
            startMs: 0,
            endMs: this.playheadMs(),
            text: delta,
            language: this.loaded?.language,
          },
          options,
          CAPTION_PLAYHEAD_PRIORITY,
        );
      },
      cancel: (delta, context) => {
        this.translator.cancelText(
          delta,
          asrDeltaOptions(this.translateOptions(this.loaded?.language), context),
        );
      },
      onLine: (source, translation, sequence) => {
        if (!this.running || !this.liveCaptionVisible) return;
        // Keep the last good line until this delta resolves; never paint a pending
        // placeholder over a live caption. Each sequence is a distinct cue id so the
        // 1.4 s same-line debounce cannot delay a newly spoken word.
        this.commitDisplay(
          `asr:${String(sequence)}`,
          source,
          translation,
          0,
          this.playheadMs(),
          0,
          true,
          false,
        );
      },
    });
  }

  /**
   * Translate the visible chunk as soon as it appears. The finished sentence is
   * translated with the same light context and replaces this line from cache, so
   * a provisional result never blanks the overlay or jumps back to an older chunk.
   */
  private startProvisionalLiveTranslation(
    text: string,
    options: CaptionTranslateOptions,
    revision: number,
  ): void {
    if (isSoundTagOnly(text) || (this.loaded?.asr === true && isBareSoundWord(text))) return;
    if (this.provisionalSource === text || this.liveCommittedSource === text) return;
    this.cancelProvisionalTranslation();
    const requestOptions: CaptionTranslateOptions = {
      ...options,
      ...(this.liveCommittedSource ? { context: this.liveCommittedSource } : {}),
    };
    this.provisionalSource = text;
    this.provisionalOptions = requestOptions;
    const cue: CaptionCue = {
      id: `live:chunk:${String(revision)}`,
      startMs: 0,
      endMs: this.playheadMs(),
      text,
      language: this.loaded?.language,
    };
    const cached =
      this.translator.getCached(text, requestOptions) ?? this.translator.getCached(text, options);
    if (cached) {
      this.commitDisplay(cue.id, text, cached, 0, this.playheadMs(), 0, true);
      return;
    }
    const token = this.sourceToken;
    const generation = this.translator.translateGeneration();
    void this.translator
      .translateCue(cue, requestOptions, CAPTION_PLAYHEAD_PRIORITY)
      .then((translation) => {
        if (
          !this.running ||
          token !== this.sourceToken ||
          this.translator.abortedSince(generation) ||
          !this.liveCaptionVisible ||
          this.liveSource !== text ||
          this.liveCommittedSource === text ||
          !translation
        ) {
          return;
        }
        this.commitDisplay(cue.id, text, translation, 0, this.playheadMs(), 0, true);
      });
  }

  /** Warm timedtext cues that are already available inside the ASR window. */
  private warmAsrTrack(): void {
    const loaded = this.loaded;
    // ASR prefetch is for a growing live track; ordinary timedtext keeps its existing path.
    if (!this.liveMode || !loaded?.asr || loaded.cues.length === 0) return;
    // A live DOM caption is the source of truth. Prefetching the whole timedtext
    // window here would fill the engine queue and starve the newest spoken chunk.
    if (this.readSourceCaptionDom().length > 0) return;
    const rate = Number.isFinite(this.video?.playbackRate) ? (this.video?.playbackRate ?? 1) : 1;
    this.translator.prefetch(
      loaded.cues,
      this.playheadMs(),
      this.translateOptions(loaded.language),
      this.prefs.tier,
      rate,
      new Set(),
      CAPTION_PREFETCH_MAX_CUES,
    );
  }
  private shouldCommitLiveSentence(now: number, next: string): boolean {
    return (
      this.liveUtterance.length > 0 &&
      (LIVE_SENTENCE_END_RE.test(this.liveUtterance) ||
        /(?:です|ます|でした|ました|ね|よ|か)$/u.test(this.liveUtterance) ||
        /^[A-Z]/u.test(next) ||
        now - this.liveLastChangeAt >= LIVE_SENTENCE_GAP_MS ||
        this.liveUtterance.length >= LIVE_SENTENCE_MAX_CHARS)
    );
  }

  private commitLiveSentence(options: CaptionTranslateOptions): void {
    if (this.liveUtterance.length === 0) return;
    const text = this.liveUtterance;
    const committedSource = this.liveCommittedSource;
    this.liveCommittedSource = text;
    this.liveUtterance = '';
    this.cancelLiveTailJob();
    if (isSoundTagOnly(text) || (this.loaded?.asr === true && isBareSoundWord(text))) return;
    this.commitDisplay(
      `live:${String(this.liveTailRevision)}`,
      text,
      '',
      0,
      this.playheadMs(),
      0,
      this.liveMode,
      true,
    );
    this.startLiveTailTranslation(options, this.liveTailRevision, text, committedSource);
  }

  private startLiveTailTranslation(
    options: CaptionTranslateOptions,
    revision: number,
    text: string,
    committedSource: string,
  ): void {
    if (!this.liveCaptionVisible) return;
    const requestOptions: CaptionTranslateOptions = {
      ...options,
      ...(committedSource && text !== committedSource ? { context: committedSource } : {}),
    };
    const cached =
      this.translator.getCached(text, options) ?? this.translator.getCached(text, requestOptions);
    if (cached) {
      this.commitDisplay(
        `live:${String(revision)}`,
        text,
        cached,
        0,
        this.playheadMs(),
        0,
        true,
        false,
      );
      return;
    }

    const job: LiveTailJob = { text, options: requestOptions, revision };
    this.liveTailJob = job;
    const cue: CaptionCue = {
      id: `live:${String(revision)}`,
      startMs: 0,
      endMs: this.playheadMs(),
      text,
      language: this.loaded?.language,
    };
    const token = this.sourceToken;
    const generation = this.translator.translateGeneration();
    void this.translator
      .translateCue(cue, requestOptions, CAPTION_PLAYHEAD_PRIORITY)
      .then((translation) => {
        if (
          !this.running ||
          token !== this.sourceToken ||
          this.liveTailJob !== job ||
          !this.liveCaptionVisible
        ) {
          return;
        }
        this.liveTailJob = null;
        if (this.translator.abortedSince(generation)) return;
        if (!translation) {
          this.showNative('translate-failed');
          return;
        }
        this.commitDisplay(
          `live:${String(revision)}`,
          text,
          translation,
          0,
          this.playheadMs(),
          0,
          true,
          false,
        );
      });
  }

  private cancelLiveTailJob(): void {
    const job = this.liveTailJob;
    if (!job) return;
    this.liveTailJob = null;
    this.translator.cancelText(job.text, job.options);
  }

  /** Abort an in-flight provisional request without touching prefetched neighbours. */
  private cancelProvisionalTranslation(): void {
    if (this.provisionalSource && this.provisionalOptions) {
      this.translator.cancelText(this.provisionalSource, this.provisionalOptions);
    }
    this.provisionalSource = '';
    this.provisionalOptions = null;
  }

  /**
   * The native caption has cleared. Reset the provisional source too: otherwise an
   * identical chunk returning after a gap hits the early return in
   * startProvisionalLiveTranslation and is never looked up or painted again.
   */
  private clearLiveSource(): void {
    this.asrStream?.reset();
    this.liveCaptionVisible = false;
    this.liveSource = '';
    this.liveUtterance = '';
    this.liveLastChangeAt = 0;
    this.liveCommittedSource = '';
    this.liveTailRevision += 1;
    this.clearHoldTimer();
    this.cancelLiveTailJob();
    this.cancelProvisionalTranslation();
  }

  private resetLiveCaptions(): void {
    this.asrStream?.reset();
    this.clearHoldTimer();
    this.cancelLiveTailJob();
    this.liveSource = '';
    this.liveUtterance = '';
    this.liveCommittedSource = '';
    this.liveLastChangeAt = 0;
    this.liveTailJob = null;
    this.liveTailRevision = 0;
    this.liveCaptionVisible = false;
    this.cancelProvisionalTranslation();
  }

  private bindVideo(video: HTMLVideoElement | null): void {
    if (!video) return;
    video.addEventListener('timeupdate', this.onMedia);
    video.addEventListener('ratechange', this.onRate);
    video.addEventListener('loadedmetadata', this.onMediaSource);
    video.addEventListener('emptied', this.onMediaSource);
    video.addEventListener('loadstart', this.onMediaSource);
    video.addEventListener('cuechange', this.onMedia, true);
    this.listenForTracks(video.textTracks);
    this.observeLayout(video);
    this.observePlayer(video);
    this.applyNativeVisibility();
  }

  private unbindVideo(video: HTMLVideoElement | null): void {
    this.disconnectLayout();
    this.playerObserver?.disconnect();
    this.playerObserver = null;
    if (!video) return;
    video.removeEventListener('timeupdate', this.onMedia);
    video.removeEventListener('ratechange', this.onRate);
    video.removeEventListener('loadedmetadata', this.onMediaSource);
    video.removeEventListener('emptied', this.onMediaSource);
    video.removeEventListener('loadstart', this.onMediaSource);
    video.removeEventListener('cuechange', this.onMedia, true);
    this.listenForTracks(null);
  }

  private observePlayer(video: HTMLVideoElement): void {
    this.playerObserver?.disconnect();
    const root = captionOverlayRoot(this.doc, video);
    const view = this.doc.defaultView;
    if (!view || typeof view.MutationObserver !== 'function') return;
    this.playerObserver = new view.MutationObserver((records) => {
      if (!this.running || this.ignorePlayerMutations) return;
      for (const record of records) {
        const node = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!node) continue;
        if (node.closest(CAPTION_OVERLAY_HOST)) continue;
        if (node.closest(`[data-sakutto="${CAPTION_ORIGINAL_TOGGLE}"]`)) continue;
        void this.sync(false);
        return;
      }
    });
    this.playerObserver.observe(root, { childList: true, subtree: true });
  }

  private observeLayout(video: HTMLVideoElement): void {
    this.disconnectLayout();
    const view = this.doc.defaultView;
    if (!view || typeof view.ResizeObserver !== 'function') return;
    const root = captionOverlayRoot(this.doc, video);
    this.resizeObserver = new view.ResizeObserver(() => this.schedulePlace());
    this.resizeObserver.observe(video);
    if (root instanceof Element && root !== video) this.resizeObserver.observe(root);
  }

  private disconnectLayout(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    const view = this.doc.defaultView;
    if (this.placeFrame !== null) {
      view?.cancelAnimationFrame(this.placeFrame);
      this.placeFrame = null;
    }
    if (this.placeSettleTimer !== null) {
      view?.clearTimeout(this.placeSettleTimer);
      this.placeSettleTimer = null;
    }
    if (this.seekPaintTimer !== null) {
      view?.clearTimeout(this.seekPaintTimer);
      this.seekPaintTimer = null;
    }
  }

  private schedulePlace(): void {
    const view = this.doc.defaultView;
    if (!view) {
      this.place();
      return;
    }
    if (this.placeFrame !== null) view.cancelAnimationFrame(this.placeFrame);
    this.placeFrame = view.requestAnimationFrame(() => {
      this.placeFrame = view.requestAnimationFrame(() => {
        this.placeFrame = null;
        this.place();
      });
    });
    if (this.placeSettleTimer !== null) view.clearTimeout(this.placeSettleTimer);
    this.placeSettleTimer = view.setTimeout(() => {
      this.placeSettleTimer = null;
      this.place();
    }, 160);
  }

  private place(): void {
    if (!this.video) return;
    const root = captionOverlayRoot(this.doc, this.video);
    this.ignorePlayerMutations = true;
    this.overlay.attach(root);
    const videoRect = this.video.getBoundingClientRect();
    const playerRect = root instanceof Element ? root.getBoundingClientRect() : null;
    const rect = pickCaptionLayoutRect(videoRect, playerRect, this.lastLayout);
    if (rect.width >= CAPTION_LAYOUT_MIN_PX && rect.height >= CAPTION_LAYOUT_MIN_PX) {
      this.lastLayout = rect;
    }
    this.overlay.place(
      rect,
      captionOverlayFontPx(
        rect.height,
        nativeCaptionFontPx(this.doc),
        this.prefs.size ?? VIDEO_CAPTION_SIZE_DEFAULT,
      ),
      captionChromeInset(root),
      this.prefs.position ?? null,
    );
    this.releasePlayerMutations();
  }

  private releasePlayerMutations(): void {
    const view = this.doc.defaultView;
    if (!view) {
      this.ignorePlayerMutations = false;
      return;
    }
    view.queueMicrotask(() => {
      this.ignorePlayerMutations = false;
    });
  }

  private readSourceCaptionDom(): string {
    const spoken = this.loaded?.language;
    const youtube = readYoutubeCaptionDom(this.doc, {
      targetLanguage: this.prefs.targetLanguage,
      spokenLanguage: spoken,
    });
    if (youtube.length > 0) return youtube;
    if (this.isXPage()) {
      const fromDom = readXCaptionDom(this.doc, this.prefs.targetLanguage);
      if (fromDom.length > 0) return fromDom;
      if (this.video) return readXActiveCues(this.video, this.prefs.targetLanguage);
      return '';
    }
    if (!this.allowsGenericDom()) return '';
    return readGenericCaptionDom(this.doc, { targetLanguage: this.prefs.targetLanguage });
  }

  private isXPage(): boolean {
    const host = pageHost(this.doc.defaultView?.location.href ?? '') ?? '';
    return isXHost(host);
  }

  private listenForTracks(list: TextTrackList | null): void {
    if (this.boundTrackList === list) return;
    this.boundTrackList?.removeEventListener('addtrack', this.onMedia);
    this.boundTrackList = list;
    list?.addEventListener('addtrack', this.onMedia);
  }

  private allowsGenericDom(): boolean {
    const host = pageHost(this.doc.defaultView?.location.href ?? '') ?? '';
    if (isYouTubeHost(host) || isXHost(host)) return false;
    return hostMatchesCaptionCustom(host, this.prefs.customHosts ?? []);
  }

  private pickSessionVideo(): HTMLVideoElement | null {
    const host = pageHost(this.doc.defaultView?.location.href ?? '') ?? '';
    if (isXHost(host)) return pickPlayingXVideo(this.doc, this.lastPlayed);
    if (isYouTubeHost(host)) return pickPrimaryVideo(this.doc);
    if (this.lastPlayed?.isConnected && !this.lastPlayed.paused && !this.lastPlayed.ended) {
      return this.lastPlayed;
    }
    return pickPlayingOrPrimaryVideo(this.doc);
  }

  /**
   * Warm the lines that will be shown next. The nearest cues go out at live
   * priority so they are ready before the playhead reaches them; farther cues use
   * the prefetch band, kept behind visible page prose and capped by the translator.
   */
  private scheduleAroundPlayhead(current: CaptionCue | null): void {
    const video = this.video;
    const cues = this.loaded?.cues ?? [];
    if (!video || cues.length === 0) return;
    const language = this.loaded?.language;
    if (sameLanguage(language, this.prefs.targetLanguage)) return;
    const timeMs = Math.round((video.currentTime || 0) * 1000);
    const options = this.translateOptions(language);
    const nearby = cuesFromPlayhead(cues, timeMs, 3).filter((cue) => cue.id !== current?.id);
    const skip = new Set<string>();
    if (current) skip.add(current.id);
    for (const cue of nearby) {
      const original = this.originalForCue(cue);
      if (original.length === 0) continue;
      skip.add(cue.id);
      const index = cues.findIndex((candidate) => candidate.id === cue.id);
      const context = index > 0 ? cues[index - 1]?.text : undefined;
      const cueOptions =
        this.loaded?.source === 'vod-json3'
          ? this.optionsForVodCue(cue)
          : context
            ? { ...options, context }
            : options;
      void this.translator.translateCue(
        { ...cue, text: original },
        cueOptions,
        CAPTION_LIVE_PRIORITY,
      );
    }
    if (this.loaded?.source === 'vod-json3') return;
    const playbackRate = video.playbackRate || 1;
    const windowMs = captionPrefetchWindowMs(this.prefs.tier, playbackRate);
    const prefetchCues = cuesInWindow(cues, timeMs, timeMs + windowMs)
      .slice(0, CAPTION_PREFETCH_MAX_CUES)
      .map((cue) => {
        const original = stripTargetLanguageFromCaption(cue.text, this.prefs.targetLanguage);
        return original.length > 0 && original !== cue.text ? { ...cue, text: original } : cue;
      });
    this.translator.prefetch(prefetchCues, timeMs, options, this.prefs.tier, playbackRate, skip);
  }

  private prefetchFromPlayhead(): void {
    const video = this.video;
    const cues = this.loaded?.cues ?? [];
    if (!video || cues.length === 0) return;
    const language = this.loaded?.language;
    if (sameLanguage(language, this.prefs.targetLanguage)) return;
    const timeMs = Math.round((video.currentTime || 0) * 1000);
    this.scheduleAroundPlayhead(cueAtTime(cues, timeMs));
  }

  /** Abort the previous playhead request, but keep the current line and its neighbours. */
  private retainAroundPlayhead(original: string, options: CaptionTranslateOptions): void {
    const texts: string[] = [original];
    for (const cue of cuesFromPlayhead(this.loaded?.cues ?? [], this.playheadMs(), 8)) {
      const stripped = stripTargetLanguageFromCaption(cue.text, this.prefs.targetLanguage);
      const text = stripped.length > 0 ? stripped : cue.text.trim();
      if (text.length > 0 && !texts.includes(text)) texts.push(text);
    }
    this.translator.retainTexts(texts, options);
  }

  private repaintHold(): void {
    const hold = this.hold;
    if (!hold) return;
    this.overlay.show({
      original: hold.original,
      translation: hold.translation,
      display: this.prefs.display,
      pending: hold.pending === true,
      ...(hold.live ? { live: true } : {}),
      ...(this.loaded?.asr === true ? { asr: true } : {}),
    });
  }

  private playheadMs(): number {
    return Math.round((this.video?.currentTime || 0) * 1000);
  }

  /**
   * True while the held line still belongs at this playhead: not before its start
   * (rewind / loop), and not more than {@link CAPTION_HOLD_MAX_MS} after it ended.
   * A current cue with an in-flight translation is handled by the caller, not here.
   */
  private holdActiveAt(timeMs: number): boolean {
    if (!this.hold) return false;
    if (timeMs < this.hold.startMs) return false;
    return timeMs <= this.hold.endMs + CAPTION_HOLD_MAX_MS;
  }

  /** Push the hold window forward while a live/DOM line is still on screen. */
  private extendHold(timeMs: number): void {
    if (!this.hold) return;
    this.hold.endMs = Math.max(this.hold.endMs, timeMs);
  }

  private commitDisplay(
    cueId: string,
    original: string,
    translation: string,
    startMs: number,
    endMs: number,
    minDisplayMs = LIVE_CAPTION_MIN_DISPLAY_MS,
    live = false,
    pending = false,
  ): void {
    if (!this.running) return;
    const token = this.sourceToken;
    if (
      this.hold?.cueId === cueId &&
      this.hold.original === original &&
      this.hold.translation === translation &&
      this.hold.live === live &&
      (this.hold.pending === true) === pending
    ) {
      this.hold.endMs = Math.max(this.hold.endMs, endMs);
      return;
    }
    const apply = (): void => {
      if (!this.running || token !== this.sourceToken) return;
      this.holdTimer = null;
      if (live && !this.liveCaptionVisible) return;
      this.hold = {
        cueId,
        original,
        translation,
        shownAt: this.now(),
        startMs,
        endMs,
        pending,
        ...(live ? { live: true } : {}),
      };
      this.ignorePlayerMutations = true;
      this.overlay.show({
        original,
        translation,
        display: this.prefs.display,
        pending,
        ...(live ? { live: true } : {}),
        ...(this.loaded?.asr === true ? { asr: true } : {}),
        ...(this.loaded?.source === 'vod-json3' ? { vodJson3: true } : {}),
      });
      this.applyNativeVisibility();
      this.releasePlayerMutations();
    };
    const elapsed = this.hold ? this.now() - this.hold.shownAt : minDisplayMs;
    const wait = Math.max(0, minDisplayMs - elapsed);
    if (this.holdTimer !== null) this.doc.defaultView?.clearTimeout(this.holdTimer);
    // A new playhead cue must replace the previous translated line immediately.
    // Min-display only debounce refinements of the same live/ASR line.
    if (wait === 0 || !this.hold || this.hold.cueId !== cueId) {
      apply();
      return;
    }
    this.holdTimer = this.doc.defaultView?.setTimeout(apply, wait) ?? null;
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      this.doc.defaultView?.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private clearHold(): void {
    this.clearHoldTimer();
    this.hold = null;
  }

  private async readYouTubeCues(
    baseUrl: string,
    language: string,
    asr: boolean,
    live: boolean,
  ): Promise<{ cues: CaptionCue[]; timeline?: VodTimeline | undefined }> {
    const json3 = await this.readTrack(withTimedtextFormat(baseUrl, 'json3'));
    const parsedCues = parseTimedtextPayload(json3, 'json3', language);
    let rawJson3: unknown;
    try {
      rawJson3 = JSON.parse(json3) as unknown;
    } catch {
      rawJson3 = undefined;
    }
    const timeline = live ? null : parseVodJson3Timeline(rawJson3, language, asr);
    if (timeline) return { cues: timeline.cues, timeline };
    const fromJson = buildSentenceUnitsFromTrack(parsedCues, live ? undefined : rawJson3);
    if (fromJson.length > 0) return { cues: fromJson };
    const vtt = await this.readTrack(withTimedtextFormat(baseUrl, 'vtt'));
    return { cues: buildSentenceUnitsFromTrack(parseTimedtextPayload(vtt, 'vtt', language)) };
  }

  private translateOptions(language?: string): CaptionTranslateOptions {
    const src = captionLanguagePrefix(language) || undefined;
    return {
      tgt: this.prefs.targetLanguage,
      form: this.prefs.form,
      glossary: this.prefs.glossary,
      asr: this.loaded?.asr === true,
      ...(src ? { src } : {}),
    };
  }

  private togglePlayback(): void {
    const video = this.video;
    if (!video) return;
    if (video.paused || video.ended) void video.play().catch(() => undefined);
    else video.pause();
  }

  private hideNativeCaptions(hide: boolean): void {
    if (!hide) {
      this.nativeStyle?.remove();
      this.nativeStyle = null;
      return;
    }
    if (this.nativeStyle) return;
    const style = this.doc.createElement('style');
    style.setAttribute('data-sakutto', 'captions');
    style.textContent = NATIVE_HIDE_STYLE;
    (this.doc.head ?? this.doc.documentElement).append(style);
    this.nativeStyle = style;
  }

  private restoreTracks(): void {
    for (const entry of this.loaded?.restoreModes ?? []) {
      try {
        entry.track.mode = entry.mode;
      } catch {
        // The track may have been removed with the video.
      }
    }
  }
}

function loadHtml5Track(
  video: HTMLVideoElement,
  targetLanguage: string,
  durationMs?: number,
  options?: { mutateMode?: boolean },
): Omit<LoadedTrack, 'key'> | null {
  const tracks = listCaptionTracks(video);
  const selected = pickCaptionTrack(tracks, targetLanguage);
  if (!selected) return null;
  const mutate = options?.mutateMode !== false;
  const restoreModes = mutate
    ? tracks
        .filter((track) => track.mode === 'showing' || track === selected)
        .map((track) => ({ track, mode: track.mode }))
    : [];
  if (mutate) {
    revealTrackCues(selected);
    for (const track of tracks) {
      if (track !== selected && track.mode === 'showing') track.mode = 'hidden';
    }
  }
  const cues = finalizeCaptionCues(cuesFromTrack(selected), durationMs);
  if (cues.length === 0 && selected.cues === null) {
    return { cues: [], language: selected.language || undefined, restoreModes };
  }
  return { cues, language: selected.language || undefined, restoreModes };
}

function sameCaptionPosition(
  left: VideoCaptionPosition | null | undefined,
  right: VideoCaptionPosition | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.x === right.x && left.y === right.y;
}

function uniqueUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function trackKey(doc: Document, video: HTMLVideoElement): string {
  return captionSourceKey(doc, video);
}

function captionSourceKey(doc: Document, video: HTMLVideoElement | null): string {
  const href = doc.defaultView?.location.href ?? '';
  const videoId = youtubeVideoId(href);
  if (videoId) return `yt:${videoId}`;
  const host = pageHost(href) ?? '';
  if (isYouTubeHost(host)) return `yt:${href}`;
  if (!video) return '';
  return `html5:${video.currentSrc || video.src || ''}`;
}

function videoTracksOf(doc: Document): TextTrackList | null {
  const video = pickPrimaryVideo(doc) ?? doc.querySelector('video');
  return video?.textTracks ?? null;
}

function hideShowingCaptionTracks(video: HTMLVideoElement): void {
  try {
    for (const track of video.textTracks) {
      if (track.kind !== 'captions' && track.kind !== 'subtitles') continue;
      if (track.mode === 'showing') track.mode = 'hidden';
    }
  } catch {
    // Some players throw when a track list is mutated during playback.
  }
}

function isHtmlVideo(value: EventTarget | null): value is HTMLVideoElement {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'tagName' in value &&
    (value as HTMLElement).tagName === 'VIDEO',
  );
}

function appendLiveCaptionText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return joinCaptionFragments(left, right).replace(/\s+([.!?。！？…])/u, '$1');
}

function dedupeLiveCaptionText(visible: string): string {
  const normalized = normalizeCaptionText(visible);
  const lines = normalized.split('\n');
  const text = lines.filter((line, index) => index === 0 || line !== lines[index - 1]).join('\n');
  const repeatedHalf = /^(.+?) \1$/u.exec(text);
  return repeatedHalf?.[1] ?? text;
}

function sameLanguage(source: string | undefined, target: string): boolean {
  if (!source) return false;
  // Easy Japanese is an output style, so a Japanese caption still needs translating.
  if (isPlamoOnlyTarget(target)) return false;
  const left = canonicalLanguage(captionLanguagePrefix(source) || source);
  const right = canonicalLanguage(captionLanguagePrefix(target) || target);
  return left !== null && right !== null && left === right;
}

async function defaultReadPlayerResponse(): Promise<unknown> {
  try {
    const { browser } = await import('wxt/browser');
    const response: unknown = await browser.runtime.sendMessage({
      type: 'captions:player-response',
    });
    return response ?? null;
  } catch {
    return null;
  }
}
