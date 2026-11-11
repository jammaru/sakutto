import { pageHost } from '@/dom/sites';
import type { PageEngine } from '@/dom/session';
import type { GlossaryEntry } from '@/engine/types';
import { canonicalLanguage } from '@/shared/languages';
import { VIDEO_CAPTION_SIZE_DEFAULT, type DisplayMode, type Formality } from '@/shared/settings';
import {
  cueAtTime,
  cuesFromPlayhead,
  finalizeCaptionCues,
  LIVE_CAPTION_MIN_DISPLAY_MS,
  LiveCaptionBuffer,
  parseWebVtt,
  type CaptionCue,
} from './cues';
import {
  CAPTION_LIVE_PRIORITY,
  CAPTION_PLAYHEAD_PRIORITY,
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
import { readGenericCaptionDom } from './generic';
import {
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
import {
  isTwimgCaptionAssetUrl,
  isXHost,
  listXCaptionSourceUrls,
  listXSubtitleUrls,
  parseHlsMediaSegments,
  parseHlsSubtitleRenditions,
  pickPlayingXVideo,
  pickXSubtitleRendition,
  readXCaptionDom,
} from './x';
import {
  captionSourceIsTargetLanguage,
  captionTracksFromPlayerResponse,
  isYouTubeHost,
  isYouTubeLiveDocument,
  nativeCaptionFontPx,
  parseTimedtextPayload,
  peekYoutubeCaptionDom,
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
}

export interface CaptionSessionOptions {
  engine: PageEngine;
  labels: CaptionOverlayLabels;
  preferences: CaptionSessionPreferences;
  readTrack?: (url: string) => Promise<string>;
  readPlayerResponse?: () => Promise<unknown>;
  now?: () => number;
  onDisplayToggle?: () => void;
}

interface LoadedTrack {
  key: string;
  cues: CaptionCue[];
  language?: string | undefined;
  restoreModes: Array<{ track: TextTrack; mode: TextTrackMode }>;
}

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
  private readonly liveBuffer = new LiveCaptionBuffer();
  private readonly timedtextGuard = new TimedtextFetchGuard();
  private prefs: CaptionSessionPreferences;
  private running = false;
  private video: HTMLVideoElement | null = null;
  private loaded: LoadedTrack | null = null;
  private loadInFlight = false;
  private nativeStyle: HTMLStyleElement | null = null;
  private observer: MutationObserver | null = null;
  private liveTimer: number | null = null;
  private liveTrackTimer: number | null = null;
  private liveMode = false;
  private useDomCaptions = false;
  private timedtextKey = '';
  private hold: {
    cueId: string;
    original: string;
    translation: string;
    shownAt: number;
  } | null = null;
  private holdTimer: number | null = null;
  private liveJobId: string | null = null;
  private lastPlayed: HTMLVideoElement | null = null;
  private sourceKey = '';
  private sourceToken = 0;
  private passthroughNative = false;
  private historyUnpatch: (() => void) | null = null;
  private lastLayout: CaptionLayoutRect | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private placeFrame: number | null = null;
  private placeSettleTimer: number | null = null;
  private seekPaintTimer: number | null = null;

  constructor(doc: Document, options: CaptionSessionOptions) {
    this.doc = doc;
    this.prefs = options.preferences;
    this.readTrack = options.readTrack ?? readTimedtext;
    this.readPlayerResponse = options.readPlayerResponse ?? defaultReadPlayerResponse;
    this.now = options.now ?? (() => Date.now());
    this.translator = new CaptionTranslator(options.engine);
    this.overlay = new CaptionOverlay(doc, options.labels);
    this.overlay.setOnDisplayToggle(() => options.onDisplayToggle?.());
  }

  setPreferences(preferences: CaptionSessionPreferences): void {
    const wasEnabled = this.prefs.enabled;
    const targetChanged = this.prefs.targetLanguage !== preferences.targetLanguage;
    const displayChanged = this.prefs.display !== preferences.display;
    const sizeChanged =
      (this.prefs.size ?? VIDEO_CAPTION_SIZE_DEFAULT) !==
      (preferences.size ?? VIDEO_CAPTION_SIZE_DEFAULT);
    this.prefs = { ...preferences, tier: this.prefs.tier ?? preferences.tier };
    if (!preferences.enabled) {
      this.stop();
      return;
    }
    if (!wasEnabled) {
      this.start();
      return;
    }
    if (targetChanged) {
      this.resetCaptionSource();
      this.passthroughNative = false;
      void this.sync(true);
      return;
    }
    if (displayChanged || sizeChanged) {
      this.place();
      this.repaintHold();
    }
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
    videoTracksOf(this.doc)?.addEventListener('addtrack', this.onMedia);
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
    this.liveTrackTimer =
      view?.setInterval(() => {
        if (!this.video) return;
        if (this.liveMode) {
          void this.refreshLiveTrack(this.video);
          return;
        }
        if (
          (this.loaded?.cues.length ?? 0) === 0 &&
          this.timedtextKey.length > 0 &&
          this.timedtextGuard.allow(this.timedtextKey, this.now())
        ) {
          void this.loadTrack(this.video);
        }
      }, 2_500) ?? null;
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
    videoTracksOf(this.doc)?.removeEventListener('addtrack', this.onMedia);
    this.doc.removeEventListener('fullscreenchange', this.onPlace);
    this.doc.removeEventListener('yt-navigate-start', this.onNavigate);
    this.doc.removeEventListener('yt-navigate-finish', this.onNavigate);
    this.doc.removeEventListener('yt-page-data-updated', this.onNavigate);
    view?.removeEventListener('popstate', this.onNavigate);
    this.historyUnpatch?.();
    this.historyUnpatch = null;
    this.observer?.disconnect();
    this.observer = null;
    this.disconnectLayout();
    if (this.liveTimer !== null) {
      view?.clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
    if (this.liveTrackTimer !== null) {
      view?.clearInterval(this.liveTrackTimer);
      this.liveTrackTimer = null;
    }
    this.liveMode = false;
    this.useDomCaptions = false;
    this.timedtextKey = '';
    this.loadInFlight = false;
    this.timedtextGuard.reset();
    this.restoreTracks();
    this.hideNativeCaptions(false);
    this.translator.clear();
    this.liveBuffer.reset();
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
    this.liveJobId = null;
    this.overlay.hide();
    this.overlay.detach();
  }

  private readonly onMedia = (): void => {
    void this.sync(false);
  };

  private readonly onPlay = (event: Event): void => {
    const target = event.target;
    if (isHtmlVideo(target)) this.lastPlayed = target;
    void this.sync(true);
  };

  private readonly onSeek = (): void => {
    this.liveBuffer.reset();
    this.liveJobId = null;
    this.fallbackToNative();
    const view = this.doc.defaultView;
    if (this.seekPaintTimer !== null) {
      view?.clearTimeout(this.seekPaintTimer);
    } else {
      this.translator.seek();
    }
    this.seekPaintTimer =
      view?.setTimeout(() => {
        this.seekPaintTimer = null;
        void this.paint(true);
      }, 64) ?? null;
  };

  private readonly onRate = (): void => {
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
    this.timedtextKey = '';
    this.timedtextGuard.reset();
    this.translator.clear();
    this.liveBuffer.reset();
    this.clearHold();
    this.liveJobId = null;
    this.passthroughNative = false;
    this.lastLayout = null;
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
      const host = pageHost(this.doc.defaultView?.location.href ?? '') ?? '';
      const youtube = await this.loadYouTubeTrack();
      if (token !== this.sourceToken) return;
      if (youtube) {
        this.liveMode = youtube.live;
        this.finishLoadedTrack({ key, ...youtube, restoreModes: [] });
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
        this.useDomCaptions = (xTrack?.cues.length ?? 0) === 0;
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
    const response =
      liveResponse ?? playerResponseForPage(this.doc, playerResponseFromDocument(this.doc));
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
      return { cues: [], language: selected.languageCode, live };
    }

    const fetchKey = `${youtubeVideoId(this.doc.defaultView?.location.href ?? '') ?? 'yt'}:${selected.baseUrl}`;
    if (!stillCurrent()) return null;
    this.timedtextKey = fetchKey;
    if (!live) {
      const now = this.now();
      if (!this.timedtextGuard.allow(fetchKey, now) || !this.timedtextGuard.begin(fetchKey)) {
        return {
          cues: this.loaded?.cues ?? [],
          language: selected.languageCode,
          live,
        };
      }
    }

    try {
      const cues = await this.readYouTubeCues(
        selected.baseUrl,
        selected.languageCode,
        selected.asr,
      );
      if (!stillCurrent()) {
        this.timedtextGuard.reset(fetchKey);
        return null;
      }
      if (cues.length > 0) {
        if (!live) this.timedtextGuard.succeed(fetchKey);
        this.useDomCaptions = live;
        return { cues, language: selected.languageCode, live };
      }
      if (!live) this.timedtextGuard.fail(fetchKey, this.now());
      this.useDomCaptions = true;
      return { cues: [], language: selected.languageCode, live };
    } catch {
      if (!stillCurrent()) {
        this.timedtextGuard.reset(fetchKey);
        return null;
      }
      if (!live) this.timedtextGuard.fail(fetchKey, this.now());
      this.useDomCaptions = true;
      return { cues: [], language: selected.languageCode, live };
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
      restoreModes: [],
    });
  }

  private async loadXTrack(video: HTMLVideoElement): Promise<Omit<LoadedTrack, 'key'> | null> {
    const durationMs = Number.isFinite(video.duration) ? video.duration * 1000 : undefined;
    const html5 = loadHtml5Track(video, this.prefs.targetLanguage, durationMs, {
      mutateMode: false,
    });
    if (html5 && html5.cues.length > 0) return html5;

    const urls = uniqueUrls([...listXSubtitleUrls(video), ...listXCaptionSourceUrls(video)]);
    const visited = new Set<string>();
    for (const url of urls) {
      const loaded = await this.loadXCaptionUrl(url, durationMs, visited);
      if (loaded && loaded.cues.length > 0) {
        return { ...loaded, restoreModes: html5?.restoreModes ?? [] };
      }
    }
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
    } catch {
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
    this.loaded = loaded;
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
    const sample =
      this.loaded?.cues.find((cue) => cue.text.trim().length > 0)?.text ??
      peekYoutubeCaptionDom(this.doc);
    return captionSourceIsTargetLanguage(
      this.loaded?.language,
      sample.length > 0 ? sample : undefined,
      this.prefs.targetLanguage,
    );
  }

  private overlayShowingTranslation(): boolean {
    if (this.passthroughNative || !this.hold) return false;
    return this.hold.translation.trim().length > 0;
  }

  private applyNativeVisibility(): void {
    if (this.passthroughNative) {
      this.hideNativeCaptions(false);
      this.restoreTracks();
      this.clearNativeCaptionMasks();
      this.doc.documentElement.setAttribute('data-sakutto-captions', 'native');
      this.overlay.hide();
      return;
    }
    if (!this.overlayShowingTranslation()) {
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

  private fallbackToNative(): void {
    this.clearHold();
    this.overlay.hide();
    this.applyNativeVisibility();
  }

  private clearNativeCaptionMasks(): void {
    for (const node of this.doc.querySelectorAll('[data-sakutto-native-caption]')) {
      node.removeAttribute('data-sakutto-native-caption');
    }
  }

  private async paint(force: boolean): Promise<void> {
    if (!this.running) return;
    const token = this.sourceToken;
    const video = this.video;
    if (!video) return;
    if (this.passthroughNative) {
      this.applyNativeVisibility();
      this.overlay.hide();
      return;
    }
    this.place();
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
    if (this.liveMode || this.useDomCaptions) {
      if (this.readSourceCaptionDom().length > 0) {
        this.pollLive();
        return;
      }
      if (cue) {
        await this.paintCue(cue, force);
        return;
      }
      if (this.useDomCaptions) this.pollLive();
      if (token === this.sourceToken && !this.hold) this.fallbackToNative();
      return;
    }
    if (!cue) {
      this.pollLive();
      if (token === this.sourceToken && !this.hold) this.fallbackToNative();
      return;
    }
    await this.paintCue(cue, force);
  }

  private async paintCue(cue: CaptionCue, force: boolean): Promise<void> {
    if (this.passthroughNative) return;
    const token = this.sourceToken;
    const language = cue.language ?? this.loaded?.language;
    const options = this.translateOptions(language);
    const original = stripTargetLanguageFromCaption(cue.text, this.prefs.targetLanguage);
    if (original.length === 0) {
      this.fallbackToNative();
      return;
    }
    if (sameLanguage(language, this.prefs.targetLanguage)) {
      this.passthroughNative = true;
      this.applyNativeVisibility();
      return;
    }

    const cached = this.translator.getCached(original, options);
    if (cached) {
      this.commitDisplay(cue.id, original, cached);
      this.scheduleAroundPlayhead(cue);
      return;
    }
    if (this.hold?.cueId !== cue.id) this.fallbackToNative();
    if (force) this.clearHold();
    const translated = await this.translator.translateCue(
      { ...cue, text: original },
      options,
      CAPTION_PLAYHEAD_PRIORITY,
    );
    if (!this.running || token !== this.sourceToken) return;
    const timeMs = Math.round((this.video?.currentTime || 0) * 1000);
    const current = cueAtTime(this.loaded?.cues ?? [], timeMs);
    if (current && current.id !== cue.id) return;
    if (translated) this.commitDisplay(cue.id, original, translated);
    else this.fallbackToNative();
    this.scheduleAroundPlayhead(cue);
  }

  private pollLive(): void {
    if (!this.running) return;
    if (this.passthroughNative) {
      this.overlay.hide();
      return;
    }
    if (!this.liveMode && !this.useDomCaptions) return;
    const visible = this.readSourceCaptionDom();
    if (visible.length === 0) {
      if (this.liveMode) return;
      if ((this.loaded?.cues.length ?? 0) > 0) return;
      return;
    }
    if (!this.liveMode && (this.loaded?.cues.length ?? 0) > 0) return;

    const lines = this.liveBuffer.update(visible, this.now());
    const options = this.translateOptions(this.loaded?.language);
    if (sameLanguage(this.loaded?.language, this.prefs.targetLanguage)) {
      this.passthroughNative = true;
      this.applyNativeVisibility();
      this.overlay.hide();
      return;
    }

    const newest = lines.at(-1);
    if (!newest) {
      this.fallbackToNative();
      return;
    }
    const cached = this.translator.getCached(newest, options);
    if (cached) {
      this.commitDisplay(`live:${newest}`, newest, cached);
      return;
    }
    this.fallbackToNative();
    this.translator.keepOnly(newest, options);
    this.liveJobId = newest;
    const cue: CaptionCue = {
      id: `live:${newest}`,
      startMs: this.now(),
      endMs: this.now() + 2_000,
      text: newest,
      language: this.loaded?.language,
    };
    const token = this.sourceToken;
    void this.translator
      .translateCue(cue, options, CAPTION_PLAYHEAD_PRIORITY)
      .then((translation) => {
        if (!this.running || token !== this.sourceToken) return;
        if (this.liveJobId !== newest) return;
        if (translation) this.commitDisplay(cue.id, newest, translation);
        else this.fallbackToNative();
      });
  }

  private bindVideo(video: HTMLVideoElement | null): void {
    if (!video) return;
    video.addEventListener('timeupdate', this.onMedia);
    video.addEventListener('ratechange', this.onRate);
    video.addEventListener('loadedmetadata', this.onMedia);
    video.addEventListener('emptied', this.onMediaSource);
    video.addEventListener('loadstart', this.onMediaSource);
    video.addEventListener('cuechange', this.onMedia, true);
    video.textTracks.addEventListener('addtrack', this.onMedia);
    this.observeLayout(video);
    this.applyNativeVisibility();
  }

  private unbindVideo(video: HTMLVideoElement | null): void {
    this.disconnectLayout();
    if (!video) return;
    video.removeEventListener('timeupdate', this.onMedia);
    video.removeEventListener('ratechange', this.onRate);
    video.removeEventListener('loadedmetadata', this.onMedia);
    video.removeEventListener('emptied', this.onMediaSource);
    video.removeEventListener('loadstart', this.onMediaSource);
    video.removeEventListener('cuechange', this.onMedia, true);
    video.textTracks.removeEventListener('addtrack', this.onMedia);
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
    );
  }

  private readSourceCaptionDom(): string {
    const spoken = this.loaded?.language;
    const youtube = readYoutubeCaptionDom(this.doc, {
      targetLanguage: this.prefs.targetLanguage,
      spokenLanguage: spoken,
    });
    if (youtube.length > 0) return youtube;
    if (this.isXPage()) {
      return readXCaptionDom(this.doc, this.prefs.targetLanguage);
    }
    if (!this.allowsGenericDom()) return '';
    return readGenericCaptionDom(this.doc, { targetLanguage: this.prefs.targetLanguage });
  }

  private isXPage(): boolean {
    const host = pageHost(this.doc.defaultView?.location.href ?? '') ?? '';
    return isXHost(host);
  }

  private allowsGenericDom(): boolean {
    const host = pageHost(this.doc.defaultView?.location.href ?? '') ?? '';
    return !isYouTubeHost(host) && !isXHost(host);
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

  private scheduleAroundPlayhead(current: CaptionCue): void {
    const video = this.video;
    const cues = this.loaded?.cues ?? [];
    if (!video || cues.length === 0) return;
    const language = this.loaded?.language;
    if (sameLanguage(language, this.prefs.targetLanguage)) return;
    const timeMs = Math.round((video.currentTime || 0) * 1000);
    const options = this.translateOptions(language);
    const nearby = cuesFromPlayhead(cues, timeMs, 3).filter((cue) => cue.id !== current.id);
    const skip = new Set<string>([current.id]);
    for (const cue of nearby) {
      const original = stripTargetLanguageFromCaption(cue.text, this.prefs.targetLanguage);
      if (original.length === 0) continue;
      skip.add(cue.id);
      void this.translator.translateCue({ ...cue, text: original }, options, CAPTION_LIVE_PRIORITY);
    }
    this.translator.prefetch(cues, timeMs, options, this.prefs.tier, video.playbackRate || 1, skip);
  }

  private prefetchFromPlayhead(): void {
    const video = this.video;
    const cues = this.loaded?.cues ?? [];
    if (!video || cues.length === 0) return;
    const language = this.loaded?.language;
    if (sameLanguage(language, this.prefs.targetLanguage)) return;
    const timeMs = Math.round((video.currentTime || 0) * 1000);
    const current = cueAtTime(cues, timeMs);
    if (current) {
      this.scheduleAroundPlayhead(current);
      return;
    }
    this.translator.prefetch(
      cues,
      timeMs,
      this.translateOptions(language),
      this.prefs.tier,
      video.playbackRate || 1,
    );
  }

  private repaintHold(): void {
    if (!this.hold) return;
    this.overlay.show({
      original: this.hold.original,
      translation: this.hold.translation,
      display: this.prefs.display,
      pending: false,
    });
  }

  private commitDisplay(cueId: string, original: string, translation: string): void {
    if (!this.running) return;
    const token = this.sourceToken;
    if (this.hold?.cueId === cueId && this.hold.translation === translation) return;
    const apply = (): void => {
      if (!this.running || token !== this.sourceToken) return;
      this.holdTimer = null;
      this.hold = { cueId, original, translation, shownAt: this.now() };
      this.overlay.show({
        original,
        translation,
        display: this.prefs.display,
        pending: false,
      });
      this.applyNativeVisibility();
    };
    const elapsed = this.hold ? this.now() - this.hold.shownAt : LIVE_CAPTION_MIN_DISPLAY_MS;
    const wait = Math.max(0, LIVE_CAPTION_MIN_DISPLAY_MS - elapsed);
    if (this.holdTimer !== null) this.doc.defaultView?.clearTimeout(this.holdTimer);
    if (wait === 0 || !this.hold) {
      apply();
      return;
    }
    this.holdTimer = this.doc.defaultView?.setTimeout(apply, wait) ?? null;
  }

  private clearHold(): void {
    if (this.holdTimer !== null) {
      this.doc.defaultView?.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.hold = null;
  }

  private async readYouTubeCues(
    baseUrl: string,
    language: string,
    asr: boolean,
  ): Promise<CaptionCue[]> {
    const json3 = await this.readTrack(withTimedtextFormat(baseUrl, 'json3'));
    const fromJson = finalizeCaptionCues(
      parseTimedtextPayload(json3, 'json3', language),
      undefined,
      {
        asr,
      },
    );
    if (fromJson.length > 0) return fromJson;
    const vtt = await this.readTrack(withTimedtextFormat(baseUrl, 'vtt'));
    return finalizeCaptionCues(parseTimedtextPayload(vtt, 'vtt', language), undefined, { asr });
  }

  private translateOptions(language?: string): CaptionTranslateOptions {
    return {
      tgt: this.prefs.targetLanguage,
      form: this.prefs.form,
      glossary: this.prefs.glossary,
      src: language,
    };
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

function sameLanguage(source: string | undefined, target: string): boolean {
  if (!source) return false;
  const left = canonicalLanguage(source);
  const right = canonicalLanguage(target);
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
