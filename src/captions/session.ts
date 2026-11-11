import { pageHost } from '@/dom/sites';
import type { PageEngine } from '@/dom/session';
import type { GlossaryEntry } from '@/engine/types';
import { canonicalLanguage } from '@/shared/languages';
import type { DisplayMode, Formality } from '@/shared/settings';
import {
  cueAtTime,
  finalizeCaptionCues,
  LIVE_CAPTION_MIN_DISPLAY_MS,
  LiveCaptionBuffer,
  parseWebVtt,
  type CaptionCue,
} from './cues';
import { CAPTION_LIVE_PRIORITY, CaptionTranslator, type CaptionTranslateOptions } from './engine';
import {
  cuesFromTrack,
  listCaptionTracks,
  pickCaptionTrack,
  pickPrimaryVideo,
  revealTrackCues,
} from './html5';
import {
  CaptionOverlay,
  captionChromeInset,
  captionOverlayFontPx,
  captionOverlayRoot,
  type CaptionOverlayLabels,
} from './overlay';
import { readTimedtext, TimedtextFetchGuard } from './timedtext';
import { isXHost, listXSubtitleUrls, pickPlayingXVideo } from './x';
import {
  captionTracksFromPlayerResponse,
  isYouTubeLiveDocument,
  nativeCaptionFontPx,
  parseTimedtextPayload,
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

const NATIVE_HIDE_STYLE = `${YOUTUBE_CAPTION_WINDOW_SELECTOR} { visibility: hidden !important; }`;

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
  private loadToken = 0;
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
    const displayChanged = this.prefs.display !== preferences.display;
    this.prefs = { ...preferences, tier: this.prefs.tier ?? preferences.tier };
    if (!preferences.enabled) {
      this.stop();
      return;
    }
    if (!wasEnabled) {
      this.start();
      return;
    }
    if (displayChanged) this.repaintHold();
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
    this.hideNativeCaptions(true);
    const view = this.doc.defaultView;
    view?.addEventListener('timeupdate', this.onMedia, true);
    view?.addEventListener('seeked', this.onSeek, true);
    view?.addEventListener('ratechange', this.onRate, true);
    view?.addEventListener('loadedmetadata', this.onMedia, true);
    view?.addEventListener('resize', this.onPlace);
    view?.addEventListener('scroll', this.onPlace, true);
    videoTracksOf(this.doc)?.addEventListener('addtrack', this.onMedia);
    this.doc.addEventListener('fullscreenchange', this.onPlace);
    this.doc.addEventListener('yt-navigate-finish', this.onNavigate);
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
    view?.removeEventListener('seeked', this.onSeek, true);
    view?.removeEventListener('ratechange', this.onRate, true);
    view?.removeEventListener('loadedmetadata', this.onMedia, true);
    view?.removeEventListener('resize', this.onPlace);
    view?.removeEventListener('scroll', this.onPlace, true);
    videoTracksOf(this.doc)?.removeEventListener('addtrack', this.onMedia);
    this.doc.removeEventListener('fullscreenchange', this.onPlace);
    this.doc.removeEventListener('yt-navigate-finish', this.onNavigate);
    this.observer?.disconnect();
    this.observer = null;
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
    this.liveJobId = null;
    this.overlay.hide();
    this.overlay.detach();
  }

  private readonly onMedia = (): void => {
    void this.paint(false);
  };

  private readonly onSeek = (): void => {
    this.translator.seek();
    this.liveBuffer.reset();
    this.clearHold();
    this.liveJobId = null;
    this.overlay.hide();
    void this.paint(true);
  };

  private readonly onRate = (): void => {
    this.prefetchFromPlayhead();
  };

  private readonly onPlace = (): void => {
    this.place();
  };

  private readonly onNavigate = (): void => {
    this.loaded = null;
    this.useDomCaptions = false;
    this.timedtextKey = '';
    this.timedtextGuard.reset();
    this.translator.clear();
    this.liveBuffer.reset();
    this.clearHold();
    void this.sync(true);
  };

  private async sync(forceLoad: boolean): Promise<void> {
    if (!this.running || !this.prefs.enabled) return;
    const video = pickSessionVideo(this.doc);
    if (video !== this.video) {
      this.unbindVideo(this.video);
      this.restoreTracks();
      this.video = video;
      this.loaded = null;
      this.useDomCaptions = false;
      this.timedtextKey = '';
      this.timedtextGuard.reset();
      this.liveBuffer.reset();
      this.clearHold();
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

  private async loadTrack(video: HTMLVideoElement): Promise<void> {
    if (this.loadInFlight) return;
    const token = ++this.loadToken;
    const key = trackKey(this.doc, video);
    if (this.loaded?.key === key && this.loaded.cues.length > 0) return;
    this.loadInFlight = true;
    try {
      const youtube = await this.loadYouTubeTrack();
      if (token !== this.loadToken) return;
      if (youtube) {
        this.liveMode = youtube.live;
        this.loaded = { key, ...youtube, restoreModes: [] };
        if (!youtube.live && youtube.cues.length > 0) this.prefetchFromPlayhead();
        return;
      }
      this.liveMode = false;

      const host = pageHost(this.doc.defaultView?.location.href ?? '') ?? '';
      if (isXHost(host)) {
        const xTrack = await this.loadXTrack(video);
        if (token !== this.loadToken) return;
        this.loaded = xTrack ? { key, ...xTrack } : { key, cues: [], restoreModes: [] };
        if ((this.loaded.cues.length ?? 0) > 0) this.prefetchFromPlayhead();
        return;
      }

      const html5 = loadHtml5Track(
        video,
        this.prefs.targetLanguage,
        Number.isFinite(video.duration) ? video.duration * 1000 : undefined,
      );
      if (token !== this.loadToken) return;
      this.loaded = html5 ? { key, ...html5 } : { key, cues: [], restoreModes: [] };
      if ((this.loaded.cues.length ?? 0) > 0) this.prefetchFromPlayhead();
    } finally {
      if (token === this.loadToken) this.loadInFlight = false;
    }
  }

  private async loadYouTubeTrack(): Promise<
    (Omit<LoadedTrack, 'key' | 'restoreModes'> & { live: boolean }) | null
  > {
    const live = isYouTubeLiveDocument(this.doc);
    const liveResponse = await this.readPlayerResponse().catch(() => null);
    const response = liveResponse ?? playerResponseFromDocument(this.doc);
    const tracks = captionTracksFromPlayerResponse(response);
    if (tracks.length === 0 && !live) return null;
    const spoken = spokenLanguageFromPlayerResponse(response);
    const selected = live
      ? selectLiveCaptionTrack(tracks, this.prefs.targetLanguage, spoken)
      : selectCaptionTrack(tracks, this.prefs.targetLanguage, spoken);
    if (!selected) return live ? { cues: [], live: true } : null;

    const fetchKey = `${youtubeVideoId(this.doc.defaultView?.location.href ?? '') ?? 'yt'}:${selected.baseUrl}`;
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
      const cues = await this.readYouTubeCues(selected.baseUrl, selected.languageCode);
      if (cues.length > 0) {
        if (!live) this.timedtextGuard.succeed(fetchKey);
        this.useDomCaptions = live;
        return { cues, language: selected.languageCode, live };
      }
      if (!live) this.timedtextGuard.fail(fetchKey, this.now());
      this.useDomCaptions = true;
      return { cues: [], language: selected.languageCode, live };
    } catch {
      if (!live) this.timedtextGuard.fail(fetchKey, this.now());
      this.useDomCaptions = true;
      return { cues: [], language: selected.languageCode, live };
    }
  }

  private async refreshLiveTrack(video: HTMLVideoElement): Promise<void> {
    if (!this.running || !this.liveMode) return;
    const youtube = await this.loadYouTubeTrack();
    if (!youtube || !this.running) return;
    this.loaded = {
      key: trackKey(this.doc, video),
      cues: youtube.cues,
      language: youtube.language,
      restoreModes: [],
    };
  }

  private async loadXTrack(video: HTMLVideoElement): Promise<Omit<LoadedTrack, 'key'> | null> {
    const durationMs = Number.isFinite(video.duration) ? video.duration * 1000 : undefined;
    const html5 = loadHtml5Track(video, this.prefs.targetLanguage, durationMs);
    if (html5 && html5.cues.length > 0) return html5;

    const urls = listXSubtitleUrls(video);
    for (const url of urls) {
      try {
        const body = await this.readTrack(url);
        const cues = finalizeCaptionCues(parseWebVtt(body), durationMs);
        if (cues.length > 0) {
          return { cues, restoreModes: html5?.restoreModes ?? [] };
        }
      } catch {
        // Try the next published VTT URL; never invent captions.
      }
    }
    return html5;
  }

  private async paint(force: boolean): Promise<void> {
    if (!this.running) return;
    const video = this.video;
    if (!video) return;
    this.place();
    if (this.loaded && this.loaded.cues.length === 0) {
      const html5 = loadHtml5Track(
        video,
        this.prefs.targetLanguage,
        Number.isFinite(video.duration) ? video.duration * 1000 : undefined,
      );
      if (html5 && html5.cues.length > 0) {
        this.loaded = { ...this.loaded, ...html5 };
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
      return;
    }
    if (!cue) {
      this.pollLive();
      return;
    }
    await this.paintCue(cue, force);
  }

  private async paintCue(cue: CaptionCue, force: boolean): Promise<void> {
    const language = cue.language ?? this.loaded?.language;
    const options = this.translateOptions(language);
    const original = stripTargetLanguageFromCaption(cue.text, this.prefs.targetLanguage);
    if (original.length === 0) return;
    if (sameLanguage(language, this.prefs.targetLanguage)) {
      this.commitDisplay(cue.id, original, original);
      return;
    }

    this.prefetchFromPlayhead();
    const cached = this.translator.getCached(original, options);
    if (cached) {
      this.commitDisplay(cue.id, original, cached);
      return;
    }
    if (force) this.clearHold();
    const translated = await this.translator.translateCue(
      { ...cue, text: original },
      options,
      CAPTION_LIVE_PRIORITY,
    );
    if (!this.running) return;
    if (translated) this.commitDisplay(cue.id, original, translated);
  }

  private pollLive(): void {
    if (!this.running) return;
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
      const current = this.liveBuffer.peek() || visible;
      if (current.length > 0) this.commitDisplay(`live:${current}`, current, current);
      return;
    }

    const newest = lines.at(-1);
    if (!newest) return;
    const cached = this.translator.getCached(newest, options);
    if (cached) {
      this.commitDisplay(`live:${newest}`, newest, cached);
      return;
    }
    this.translator.keepOnly(newest, options);
    this.liveJobId = newest;
    const cue: CaptionCue = {
      id: `live:${newest}`,
      startMs: this.now(),
      endMs: this.now() + 2_000,
      text: newest,
      language: this.loaded?.language,
    };
    void this.translator.translateCue(cue, options, CAPTION_LIVE_PRIORITY).then((translation) => {
      if (!this.running || !translation) return;
      if (this.liveJobId !== newest) return;
      this.commitDisplay(cue.id, newest, translation);
    });
  }

  private bindVideo(video: HTMLVideoElement | null): void {
    if (!video) return;
    video.addEventListener('timeupdate', this.onMedia);
    video.addEventListener('seeked', this.onSeek);
    video.addEventListener('ratechange', this.onRate);
    video.addEventListener('loadedmetadata', this.onMedia);
    video.addEventListener('cuechange', this.onMedia, true);
    video.textTracks.addEventListener('addtrack', this.onMedia);
  }

  private unbindVideo(video: HTMLVideoElement | null): void {
    if (!video) return;
    video.removeEventListener('timeupdate', this.onMedia);
    video.removeEventListener('seeked', this.onSeek);
    video.removeEventListener('ratechange', this.onRate);
    video.removeEventListener('loadedmetadata', this.onMedia);
    video.removeEventListener('cuechange', this.onMedia, true);
    video.textTracks.removeEventListener('addtrack', this.onMedia);
  }

  private place(): void {
    if (!this.video) return;
    const root = captionOverlayRoot(this.doc, this.video);
    this.overlay.attach(root);
    const rect = this.video.getBoundingClientRect();
    this.overlay.place(
      rect,
      captionOverlayFontPx(rect.height, nativeCaptionFontPx(this.doc)),
      captionChromeInset(root),
    );
  }

  private readSourceCaptionDom(): string {
    const spoken = this.loaded?.language;
    return readYoutubeCaptionDom(this.doc, {
      targetLanguage: this.prefs.targetLanguage,
      spokenLanguage: spoken,
    });
  }

  private prefetchFromPlayhead(): void {
    const video = this.video;
    const cues = this.loaded?.cues ?? [];
    if (!video || cues.length === 0) return;
    const language = this.loaded?.language;
    if (sameLanguage(language, this.prefs.targetLanguage)) return;
    const timeMs = Math.round((video.currentTime || 0) * 1000);
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
    if (this.hold?.cueId === cueId && this.hold.translation === translation) return;
    const apply = (): void => {
      this.holdTimer = null;
      this.hold = { cueId, original, translation, shownAt: this.now() };
      this.overlay.show({
        original,
        translation,
        display: this.prefs.display,
        pending: false,
      });
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

  private async readYouTubeCues(baseUrl: string, language: string): Promise<CaptionCue[]> {
    const json3 = await this.readTrack(withTimedtextFormat(baseUrl, 'json3'));
    const fromJson = finalizeCaptionCues(parseTimedtextPayload(json3, 'json3', language));
    if (fromJson.length > 0) return fromJson;
    const vtt = await this.readTrack(withTimedtextFormat(baseUrl, 'vtt'));
    return finalizeCaptionCues(parseTimedtextPayload(vtt, 'vtt', language));
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
): Omit<LoadedTrack, 'key'> | null {
  const tracks = listCaptionTracks(video);
  const selected = pickCaptionTrack(tracks, targetLanguage);
  if (!selected) return null;
  const restoreModes = tracks
    .filter((track) => track.mode === 'showing' || track === selected)
    .map((track) => ({ track, mode: track.mode }));
  revealTrackCues(selected);
  for (const track of tracks) {
    if (track !== selected && track.mode === 'showing') track.mode = 'hidden';
  }
  const cues = finalizeCaptionCues(cuesFromTrack(selected), durationMs);
  if (cues.length === 0 && selected.cues === null) {
    return { cues: [], language: selected.language || undefined, restoreModes };
  }
  return { cues, language: selected.language || undefined, restoreModes };
}

function trackKey(doc: Document, video: HTMLVideoElement): string {
  const href = doc.defaultView?.location.href ?? '';
  const fromPlayer = youtubeVideoId(href);
  if (fromPlayer) return `yt:${fromPlayer}`;
  if (playerResponseFromDocument(doc)) return `yt:${href}`;
  return `html5:${video.currentSrc || video.src || href}`;
}

function videoTracksOf(doc: Document): TextTrackList | null {
  const video = pickSessionVideo(doc);
  return video?.textTracks ?? null;
}

function pickSessionVideo(doc: Document): HTMLVideoElement | null {
  const host = pageHost(doc.defaultView?.location.href ?? '') ?? '';
  if (isXHost(host)) return pickPlayingXVideo(doc);
  return pickPrimaryVideo(doc);
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
