import { isRecord } from '@/shared/object';
import { parseTimedtextJson3, parseWebVtt, type CaptionCue } from './cues';

export interface YoutubeCaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  asr: boolean;
  vssId?: string | undefined;
}

export const YOUTUBE_CAPTION_SEGMENT_SELECTOR = '.ytp-caption-segment';
export const YOUTUBE_CAPTION_WINDOW_SELECTOR = '.ytp-caption-window-container';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
]);

export function isYouTubeHost(host: string): boolean {
  const normalized = host.replace(/^www\./, '').toLowerCase();
  if (YOUTUBE_HOSTS.has(normalized)) return true;
  return normalized.endsWith('.youtube.com') || normalized.endsWith('.youtube-nocookie.com');
}

export function isYouTubeLivePlayer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const details = value.videoDetails;
  if (isRecord(details) && details.isLive === true) return true;
  const micro = value.microformat;
  if (isRecord(micro) && isRecord(micro.playerMicroformatRenderer)) {
    const live = micro.playerMicroformatRenderer.liveBroadcastDetails;
    if (isRecord(live) && live.isLiveNow === true) return true;
  }
  return false;
}

export function isYouTubeLiveDocument(doc: Document): boolean {
  if (isYouTubeLivePlayer(playerResponseFromDocument(doc))) return true;
  const href = doc.defaultView?.location.href ?? '';
  try {
    const parsed = new URL(href);
    const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
    if (parts[0] === 'live') return true;
  } catch {
    // Invalid href.
  }
  return Boolean(
    doc.querySelector('#movie_player.ytp-live, .html5-video-player.ytp-live, .ytp-live'),
  );
}

export function youtubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = parsed.pathname.split('/').filter((part) => part.length > 0)[0];
    return id && id.length > 0 ? id : null;
  }
  const queryId = parsed.searchParams.get('v');
  if (queryId && queryId.length > 0) return queryId;
  const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
  if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live') {
    return parts[1] && parts[1].length > 0 ? parts[1] : null;
  }
  return null;
}

/**
 * Replaces or sets `fmt` on a timedtext URL. Appending a second `fmt` leaves the original
 * (often `srv3`) in place and YouTube then returns XML instead of JSON or VTT.
 */
export function withTimedtextFormat(baseUrl: string, fmt: 'json3' | 'vtt'): string {
  const absolute = /^[a-z][a-z0-9+.-]*:/iu.test(baseUrl);
  const url = new URL(baseUrl, 'https://www.youtube.com/');
  url.searchParams.set('fmt', fmt);
  if (absolute) return url.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}

export function captionTracksFromPlayerResponse(value: unknown): YoutubeCaptionTrack[] {
  if (!isRecord(value)) return [];
  const captions = value.captions;
  if (!isRecord(captions)) return [];
  const renderer = captions.playerCaptionsTracklistRenderer;
  if (!isRecord(renderer) || !Array.isArray(renderer.captionTracks)) return [];

  const tracks: YoutubeCaptionTrack[] = [];
  for (const entry of renderer.captionTracks) {
    if (!isRecord(entry) || typeof entry.baseUrl !== 'string' || entry.baseUrl.length === 0) {
      continue;
    }
    const languageCode = typeof entry.languageCode === 'string' ? entry.languageCode : '';
    tracks.push({
      baseUrl: entry.baseUrl,
      languageCode,
      name: captionName(entry.name),
      asr: entry.kind === 'asr',
      ...(typeof entry.vssId === 'string' ? { vssId: entry.vssId } : {}),
    });
  }
  return tracks;
}

function captionName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) {
    return value.runs
      .map((run) => (isRecord(run) && typeof run.text === 'string' ? run.text : ''))
      .join('');
  }
  return '';
}

/**
 * Spoken / original caption language from the player, not the first translated track.
 * Audio-track id (`en.0`) and `defaultAudioLanguage` beat captionTracks list order
 * (translated-track lists often start at Afrikaans).
 */
export function spokenLanguageFromPlayerResponse(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const details = value.videoDetails;
  if (isRecord(details) && typeof details.defaultAudioLanguage === 'string') {
    const prefix = targetPrefix(details.defaultAudioLanguage);
    if (prefix.length > 0) return prefix;
  }

  const captions = value.captions;
  if (!isRecord(captions)) return null;
  const renderer = captions.playerCaptionsTracklistRenderer;
  if (!isRecord(renderer)) return null;

  const audioTracks = Array.isArray(renderer.audioTracks) ? renderer.audioTracks : [];
  const defaultIndex =
    typeof renderer.defaultAudioTrackIndex === 'number' ? renderer.defaultAudioTrackIndex : 0;
  const audio = isRecord(audioTracks[defaultIndex])
    ? audioTracks[defaultIndex]
    : isRecord(audioTracks[0])
      ? audioTracks[0]
      : null;
  if (audio) {
    if (typeof audio.audioTrackId === 'string') {
      const prefix = targetPrefix(audio.audioTrackId.split('.')[0] ?? '');
      if (prefix.length > 0) return prefix;
    }
    if (typeof audio.defaultCaptionTrackIndex === 'number') {
      const tracks = captionTracksFromPlayerResponse(value);
      const track = tracks[audio.defaultCaptionTrackIndex];
      const prefix = track ? targetPrefix(track.languageCode) : '';
      if (prefix.length > 0) return prefix;
    }
  }
  return null;
}

function languageMatches(track: YoutubeCaptionTrack, language: string): boolean {
  const prefix = targetPrefix(language);
  return prefix.length > 0 && track.languageCode.toLowerCase().startsWith(prefix);
}

/**
 * Prefer the video's original/spoken language (player default / audio track), then English
 * manual, then English ASR. Never the first translated track in the list.
 */
export function selectCaptionTrack(
  tracks: readonly YoutubeCaptionTrack[],
  _targetLanguage: string,
  spokenLanguage?: string | null,
): YoutubeCaptionTrack | null {
  if (tracks.length === 0) return null;
  const spoken = spokenLanguage ? targetPrefix(spokenLanguage) : '';
  const pick = (
    predicate: (track: YoutubeCaptionTrack) => boolean,
  ): YoutubeCaptionTrack | undefined => tracks.find(predicate);

  const manuals = tracks.filter((track) => !track.asr);
  return (
    (spoken.length > 0
      ? pick((track) => !track.asr && languageMatches(track, spoken))
      : undefined) ??
    pick((track) => !track.asr && languageMatches(track, 'en')) ??
    (spoken.length > 0
      ? pick((track) => track.asr && languageMatches(track, spoken))
      : undefined) ??
    pick((track) => track.asr && languageMatches(track, 'en')) ??
    pick((track) => track.asr) ??
    (manuals.length === 1 ? manuals[0] : null) ??
    null
  );
}

/** Live streams usually only have a rolling ASR track. */
export function selectLiveCaptionTrack(
  tracks: readonly YoutubeCaptionTrack[],
  targetLanguage: string,
  spokenLanguage?: string | null,
): YoutubeCaptionTrack | null {
  if (tracks.length === 0) return null;
  const spoken = spokenLanguage ? targetPrefix(spokenLanguage) : '';
  return (
    (spoken.length > 0
      ? tracks.find((track) => track.asr && languageMatches(track, spoken))
      : undefined) ??
    tracks.find((track) => track.asr) ??
    selectCaptionTrack(tracks, targetLanguage, spokenLanguage)
  );
}

function targetPrefix(targetLanguage: string): string {
  const lower = targetLanguage.trim().toLowerCase();
  if (lower.startsWith('zh-hant')) return 'zh';
  if (lower.startsWith('zh-hans')) return 'zh';
  return lower.split('-')[0] ?? '';
}

export function extractJsonObject(source: string): string | null {
  const start = source.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (character === '\\') {
        escape = true;
        continue;
      }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

export function parsePlayerResponseScript(source: string): unknown | null {
  const marker = source.indexOf('ytInitialPlayerResponse');
  if (marker === -1) return null;
  const equals = source.indexOf('=', marker);
  if (equals === -1 || equals > marker + 40) return null;
  const json = extractJsonObject(source.slice(equals + 1));
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/**
 * Reads `ytInitialPlayerResponse` from script tags in the isolated world. The page's
 * own `window.ytInitialPlayerResponse` is not visible there, and it also goes stale on
 * SPA navigation, so the script text is the source of truth.
 */
export function playerResponseFromDocument(doc: Document): unknown | null {
  for (const script of doc.querySelectorAll('script')) {
    const source = script.textContent ?? '';
    if (!source.includes('ytInitialPlayerResponse')) continue;
    const parsed = parsePlayerResponseScript(source);
    if (parsed) return parsed;
  }
  return null;
}

export function readYoutubeCaptionDom(root: ParentNode): string {
  const segments = [...root.querySelectorAll(YOUTUBE_CAPTION_SEGMENT_SELECTOR)];
  return segments
    .map((segment) => segment.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseTimedtextPayload(
  body: string,
  fmt: 'json3' | 'vtt',
  language?: string,
): CaptionCue[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  if (fmt === 'vtt' || trimmed.startsWith('WEBVTT')) return parseWebVtt(trimmed, language);
  try {
    return parseTimedtextJson3(JSON.parse(trimmed) as unknown, language);
  } catch {
    if (trimmed.startsWith('WEBVTT')) return parseWebVtt(trimmed, language);
    return [];
  }
}
