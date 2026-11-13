import { isPlamoOnlyTarget } from '@/shared/languages';
import { captionCueId, normalizeCaptionText, type CaptionCue } from './cues';

const TRACK_KINDS = new Set(['captions', 'subtitles']);

export function isCaptionTrack(track: TextTrack): boolean {
  return TRACK_KINDS.has(track.kind);
}

export function listCaptionTracks(video: HTMLVideoElement): TextTrack[] {
  return [...video.textTracks].filter(isCaptionTrack);
}

export function pickCaptionTrack(
  tracks: readonly TextTrack[],
  targetLanguage: string,
): TextTrack | null {
  if (tracks.length === 0) return null;
  const showing = tracks.find((track) => track.mode === 'showing');
  if (showing) return showing;
  // Easy Japanese has no track of its own, so a Japanese track is still a valid source.
  const target = isPlamoOnlyTarget(targetLanguage)
    ? ''
    : (targetLanguage.trim().toLowerCase().split('-')[0] ?? '');
  const notTarget = (track: TextTrack): boolean => {
    const language = track.language.trim().toLowerCase();
    return target.length === 0 || language.length === 0 || !language.startsWith(target);
  };
  return tracks.find((track) => notTarget(track)) ?? tracks[0] ?? null;
}

export function cuesFromTrack(track: TextTrack): CaptionCue[] {
  const list = track.cues;
  if (!list) return [];
  const language = track.language.trim() || undefined;
  const cues: CaptionCue[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const cue = list[index];
    if (!cue) continue;
    const text = normalizeCaptionText('text' in cue ? String(cue.text) : '');
    if (text.length === 0) continue;
    const startMs = Math.round(cue.startTime * 1000);
    const endMs = Math.round(cue.endTime * 1000);
    if (endMs <= startMs) continue;
    cues.push({
      id: captionCueId(startMs, text),
      startMs,
      endMs,
      text,
      ...(language ? { language } : {}),
    });
  }
  return cues;
}

/**
 * Reveals cues to the content script without painting the browser's own captions.
 * `disabled` tracks expose no cues; `hidden` still fires `cuechange` and fills `cues`.
 */
export function revealTrackCues(track: TextTrack): TextTrackMode {
  const previous = track.mode;
  if (track.mode !== 'hidden') track.mode = 'hidden';
  return previous;
}

export function pickPrimaryVideo(doc: Document): HTMLVideoElement | null {
  const named = doc.querySelector<HTMLVideoElement>(
    '#movie_player video.html5-main-video, #movie_player video, .html5-main-video, video',
  );
  if (named) return named;
  const videos = [...doc.querySelectorAll('video')];
  if (videos.length === 0) return null;
  return videos.reduce((best, video) => {
    const bestArea = best.clientWidth * best.clientHeight;
    const area = video.clientWidth * video.clientHeight;
    return area > bestArea ? video : best;
  });
}

/** Same-origin or absolute http(s) URLs from `<track src>` on the video. */
export function listVideoTrackUrls(video: HTMLVideoElement): string[] {
  const urls: string[] = [];
  const base = video.baseURI || video.ownerDocument?.baseURI || undefined;
  for (const track of video.querySelectorAll('track')) {
    const src = track.getAttribute('src') ?? '';
    if (src.length === 0) continue;
    try {
      const url = new URL(src, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const href = url.toString();
      if (!urls.includes(href)) urls.push(href);
    } catch {
      // Ignore malformed track URLs.
    }
  }
  return urls;
}

/** Custom sites: the playing video if any, otherwise the largest player. */
export function pickPlayingOrPrimaryVideo(doc: Document): HTMLVideoElement | null {
  const playing = [...doc.querySelectorAll('video')].filter((video) => {
    if (video.paused || video.ended) return false;
    if (video.readyState < 1) return false;
    const rect = video.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (playing.length === 1) return playing[0] ?? null;
  if (playing.length > 1) {
    return playing.reduce((best, video) => {
      const bestRect = best.getBoundingClientRect();
      const rect = video.getBoundingClientRect();
      return rect.width * rect.height > bestRect.width * bestRect.height ? video : best;
    });
  }
  return pickPrimaryVideo(doc);
}
