import { pageHost } from '@/dom/sites';
import type { PageEngine } from '@/dom/session';
import type { GlossaryEntry } from '@/engine/types';
import { canonicalLanguage } from '@/shared/languages';
import type { DisplayMode, Formality } from '@/shared/settings';
import { cueAtTime, LiveCaptionBuffer, mergeWordCues, parseWebVtt, type CaptionCue } from './cues';
import { CAPTION_LIVE_PRIORITY, CaptionTranslator, type CaptionTranslateOptions } from './engine';
import {
  cuesFromTrack,
  listCaptionTracks,
  pickCaptionTrack,
  pickPrimaryVideo,
  revealTrackCues,
} from './html5';
import { CaptionOverlay, captionOverlayRoot, type CaptionOverlayLabels } from './overlay';
import { readTimedtext } from './timedtext';
import { isXHost, listXSubtitleUrls, pickPlayingXVideo } from './x';
import {
  captionTracksFromPlayerResponse,
  isYouTubeLiveDocument,
  parseTimedtextPayload,
  playerResponseFromDocument,
  readYoutubeCaptionDom,
  selectCaptionTrack,
  selectLiveCaptionTrack,
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
  private readonly now: () => number;
  private readonly liveBuffer = new LiveCaptionBuffer();
  private prefs: CaptionSessionPreferences;
  private running = false;
  private video: HTMLVideoElement | null = null;
  private loaded: LoadedTrack | null = null;
  private loadToken = 0;
  private nativeStyle: HTMLStyleElement | null = null;
  private observer: MutationObserver | null = null;
  private liveTimer: number | null = null;
  private liveTrackTimer: number | null = null;
  private liveMode = false;
  private shownCueId: string | null = null;
  private shownText: string | null = null;

  constructor(doc: Document, options: CaptionSessionOptions) {
    this.doc = doc;
    this.prefs = options.preferences;
    this.readTrack = options.readTrack ?? readTimedtext;
    this.now = options.now ?? (() => Date.now());
    this.translator = new CaptionTranslator(options.engine);
    this.overlay = new CaptionOverlay(doc, options.labels);
    this.overlay.setOnDisplayToggle(() => options.onDisplayToggle?.());
  }

  setPreferences(preferences: CaptionSessionPreferences): void {
    const wasEnabled = this.prefs.enabled;
    this.prefs = { ...preferences, tier: this.prefs.tier ?? preferences.tier };
    if (!preferences.enabled) {
      this.stop();
      return;
    }
    if (!wasEnabled) this.start();
    else void this.sync(true);
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
        if (this.liveMode && this.video) void this.refreshLiveTrack(this.video);
      }, 2_500) ?? null;
    void this.sync(true);
  }

  stop(): void {
    this.running = false;
    const view = this.doc.defaultView;
    view?.removeEventListener('timeupdate', this.onMedia, true);
    view?.removeEventListener('seeked', this.onSeek, true);
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
    this.restoreTracks();
    this.hideNativeCaptions(false);
    this.translator.clear();
    this.liveBuffer.reset();
    this.unbindVideo(this.video);
    this.loaded = null;
    this.video = null;
    this.shownCueId = null;
    this.shownText = null;
    this.overlay.hide();
    this.overlay.detach();
  }

  private readonly onMedia = (): void => {
    void this.paint(false);
  };

  private readonly onSeek = (): void => {
    this.translator.seek();
    this.liveBuffer.reset();
    this.shownCueId = null;
    this.shownText = null;
    void this.paint(true);
  };

  private readonly onPlace = (): void => {
    this.place();
  };

  private readonly onNavigate = (): void => {
    this.loaded = null;
    this.translator.clear();
    this.liveBuffer.reset();
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
      this.liveBuffer.reset();
      this.bindVideo(video);
    }
    if (!video) {
      this.overlay.hide();
      this.overlay.detach();
      return;
    }
    this.overlay.attach(captionOverlayRoot(this.doc, video));
    this.place();
    if (forceLoad || !this.loaded || (this.loaded.cues.length === 0 && !this.liveMode)) {
      await this.loadTrack(video);
    }
    await this.paint(false);
  }

  private async loadTrack(video: HTMLVideoElement): Promise<void> {
    const token = ++this.loadToken;
    const key = trackKey(this.doc, video);
    if (this.loaded?.key === key && this.loaded.cues.length > 0) return;

    const youtube = await this.loadYouTubeTrack();
    if (token !== this.loadToken) return;
    if (youtube) {
      this.liveMode = youtube.live;
      this.loaded = { key, ...youtube, restoreModes: [] };
      return;
    }
    this.liveMode = false;

    const host = pageHost(this.doc.defaultView?.location.href ?? '') ?? '';
    if (isXHost(host)) {
      const xTrack = await this.loadXTrack(video);
      if (token !== this.loadToken) return;
      this.loaded = xTrack ? { key, ...xTrack } : { key, cues: [], restoreModes: [] };
      return;
    }

    const html5 = loadHtml5Track(video, this.prefs.targetLanguage);
    if (token !== this.loadToken) return;
    this.loaded = html5 ? { key, ...html5 } : { key, cues: [], restoreModes: [] };
  }

  private async loadYouTubeTrack(): Promise<
    (Omit<LoadedTrack, 'key' | 'restoreModes'> & { live: boolean }) | null
  > {
    const live = isYouTubeLiveDocument(this.doc);
    const response = playerResponseFromDocument(this.doc);
    const tracks = captionTracksFromPlayerResponse(response);
    const selected = live
      ? selectLiveCaptionTrack(tracks, this.prefs.targetLanguage)
      : selectCaptionTrack(tracks, this.prefs.targetLanguage);
    if (!selected) return live ? { cues: [], live: true } : null;
    const url = withTimedtextFormat(selected.baseUrl, 'json3');
    try {
      const body = await this.readTrack(url);
      const cues = mergeWordCues(parseTimedtextPayload(body, 'json3', selected.languageCode));
      if (cues.length === 0 && !live) return null;
      return { cues, language: selected.languageCode, live };
    } catch {
      return live ? { cues: [], live: true } : null;
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
    const html5 = loadHtml5Track(video, this.prefs.targetLanguage);
    if (html5 && html5.cues.length > 0) return html5;

    const urls = listXSubtitleUrls(video);
    for (const url of urls) {
      try {
        const body = await this.readTrack(url);
        const cues = mergeWordCues(parseWebVtt(body));
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
      const html5 = loadHtml5Track(video, this.prefs.targetLanguage);
      if (html5 && html5.cues.length > 0) {
        this.loaded = { ...this.loaded, ...html5 };
      }
    }

    const timeMs = Math.round((video.currentTime || 0) * 1000);
    const cues = this.loaded?.cues ?? [];
    const cue = cueAtTime(cues, timeMs);
    if (this.liveMode) {
      if (readYoutubeCaptionDom(this.doc).length > 0) {
        this.pollLive();
        return;
      }
      if (cue) {
        await this.paintCue(cue, cues, timeMs, force);
        return;
      }
      return;
    }
    if (!cue) {
      this.pollLive();
      return;
    }
    await this.paintCue(cue, cues, timeMs, force);
  }

  private async paintCue(
    cue: CaptionCue,
    cues: readonly CaptionCue[],
    timeMs: number,
    force: boolean,
  ): Promise<void> {
    const language = cue.language ?? this.loaded?.language;
    const options = this.translateOptions(language);
    this.shownCueId = cue.id;
    this.shownText = cue.text;
    if (sameLanguage(language, this.prefs.targetLanguage)) {
      this.overlay.show({
        original: cue.text,
        translation: null,
        display: this.prefs.display,
        pending: false,
      });
      return;
    }

    const cached = this.translator.getCached(cue.text, options);
    if (cached !== undefined && !force) {
      this.overlay.show({
        original: cue.text,
        translation: cached,
        display: this.prefs.display,
        pending: false,
      });
      this.translator.prefetch(cues, timeMs, options, this.prefs.tier);
      return;
    }

    this.overlay.show({
      original: cue.text,
      translation: cached ?? null,
      display: this.prefs.display,
      pending: cached === undefined,
    });
    if (cached === undefined) {
      const translated = await this.translator.translateCue(cue, options, CAPTION_LIVE_PRIORITY);
      if (this.shownCueId !== cue.id) return;
      this.overlay.show({
        original: cue.text,
        translation: translated,
        display: this.prefs.display,
        pending: false,
      });
    }
    this.translator.prefetch(cues, timeMs, options, this.prefs.tier);
  }

  private pollLive(): void {
    if (!this.running) return;
    const visible = readYoutubeCaptionDom(this.doc);
    if (visible.length === 0) {
      if (this.liveMode) return;
      if ((this.loaded?.cues.length ?? 0) > 0) return;
      if (this.shownText !== null) {
        this.overlay.hide();
        this.shownText = null;
      }
      return;
    }
    if (!this.liveMode && (this.loaded?.cues.length ?? 0) > 0) return;

    const lines = this.liveBuffer.update(visible, this.now());
    const current = this.liveBuffer.peek() || visible;
    const options = this.translateOptions(this.loaded?.language);
    this.shownCueId = `live:${current}`;
    this.shownText = current;
    if (sameLanguage(this.loaded?.language, this.prefs.targetLanguage)) {
      this.overlay.show({
        original: current,
        translation: null,
        display: this.prefs.display,
        pending: false,
      });
      return;
    }
    const cached = this.translator.getCached(current, options);
    this.overlay.show({
      original: current,
      translation: cached ?? null,
      display: this.prefs.display,
      pending: cached === undefined && this.translator.hasInflight(current, options),
    });
    for (const line of lines) {
      if (sameLanguage(this.loaded?.language, this.prefs.targetLanguage)) continue;
      const cue: CaptionCue = {
        id: `live:${line}`,
        startMs: this.now(),
        endMs: this.now() + 2_000,
        text: line,
        language: this.loaded?.language,
      };
      void this.translator.translateCue(cue, options, CAPTION_LIVE_PRIORITY).then((translation) => {
        if (!this.running) return;
        if (this.shownText !== line && this.liveBuffer.peek() !== line) return;
        this.overlay.show({
          original: line,
          translation,
          display: this.prefs.display,
          pending: false,
        });
      });
    }
  }

  private bindVideo(video: HTMLVideoElement | null): void {
    if (!video) return;
    video.addEventListener('timeupdate', this.onMedia);
    video.addEventListener('seeked', this.onSeek);
    video.addEventListener('loadedmetadata', this.onMedia);
    video.addEventListener('cuechange', this.onMedia, true);
    video.textTracks.addEventListener('addtrack', this.onMedia);
  }

  private unbindVideo(video: HTMLVideoElement | null): void {
    if (!video) return;
    video.removeEventListener('timeupdate', this.onMedia);
    video.removeEventListener('seeked', this.onSeek);
    video.removeEventListener('loadedmetadata', this.onMedia);
    video.removeEventListener('cuechange', this.onMedia, true);
    video.textTracks.removeEventListener('addtrack', this.onMedia);
  }

  private place(): void {
    if (!this.video) return;
    this.overlay.attach(captionOverlayRoot(this.doc, this.video));
    this.overlay.place(this.video.getBoundingClientRect());
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
  const cues = mergeWordCues(cuesFromTrack(selected));
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
