// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  isTwimgCaptionAssetUrl,
  isTwimgSubtitleUrl,
  isXHost,
  listXCaptionSourceUrls,
  listXSubtitleUrls,
  parseHlsMediaSegments,
  parseHlsSubtitleRenditions,
  pickPlayingXVideo,
  pickXSubtitleRendition,
  readXActiveCues,
  readXCaptionDom,
  resolveTwimgCaptionUrl,
} from '@/captions/x';

describe('X caption adapter', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('recognises X hosts and published twimg VTT URLs', () => {
    expect(isXHost('x.com')).toBe(true);
    expect(isXHost('www.twitter.com')).toBe(true);
    expect(isXHost('youtube.com')).toBe(false);
    expect(isTwimgSubtitleUrl('https://video.twimg.com/subtitles/fixture.vtt')).toBe(true);
    expect(isTwimgSubtitleUrl('https://video.twimg.com/subtitles/fixture.vtt?token=1')).toBe(true);
    expect(isTwimgSubtitleUrl('https://evil.example/subtitles/fixture.vtt')).toBe(false);
    expect(isTwimgSubtitleUrl('https://video.twimg.com/ext_tw_video/1.mp4')).toBe(false);
    expect(isTwimgCaptionAssetUrl('https://video.twimg.com/subtitles/fixture.vtt')).toBe(true);
    expect(isTwimgCaptionAssetUrl('https://video.twimg.com/amplify_video/1/pl/en.m3u8')).toBe(true);
    expect(isTwimgCaptionAssetUrl('https://video.twimg.com/ext_tw_video/1.mp4')).toBe(false);
  });

  it('resolves twimg captions only from an X page', () => {
    const twimg = 'https://video.twimg.com/subtitles/fixture.vtt';
    expect(resolveTwimgCaptionUrl('https://x.com/i/status/1', twimg)).toBe(twimg);
    expect(resolveTwimgCaptionUrl('https://twitter.com/i/status/1', twimg)).toBe(twimg);
    expect(resolveTwimgCaptionUrl('https://www.youtube.com/watch?v=abcdefghijk', twimg)).toBeNull();
  });

  it('picks the playing video and ignores a larger paused neighbour', () => {
    document.body.innerHTML = `
      <video id="idle" width="800" height="450"></video>
      <video id="playing" width="320" height="180">
        <track src="https://video.twimg.com/subtitles/fixture.vtt" kind="subtitles" />
      </video>
    `;
    const idle = document.querySelector('#idle') as HTMLVideoElement;
    const playing = document.querySelector('#playing') as HTMLVideoElement;
    stubVideo(idle, { paused: true, width: 800, height: 450 });
    stubVideo(playing, { paused: false, width: 320, height: 180 });

    expect(pickPlayingXVideo(document)).toBe(playing);
    expect(listXSubtitleUrls(playing)).toEqual(['https://video.twimg.com/subtitles/fixture.vtt']);
  });

  it('returns nothing when no X video is playing', () => {
    document.body.innerHTML = '<video id="idle" width="800" height="450"></video>';
    const idle = document.querySelector('#idle') as HTMLVideoElement;
    stubVideo(idle, { paused: true, width: 800, height: 450 });
    expect(pickPlayingXVideo(document)).toBeNull();
  });

  it('prefers the video that just received play over a larger neighbour', () => {
    document.body.innerHTML = `
      <video id="large"></video>
      <video id="inline"></video>
    `;
    const large = document.querySelector('#large') as HTMLVideoElement;
    const inline = document.querySelector('#inline') as HTMLVideoElement;
    stubVideo(large, { paused: false, width: 800, height: 450 });
    stubVideo(inline, { paused: false, width: 320, height: 180 });
    expect(pickPlayingXVideo(document, inline)).toBe(inline);
  });

  it('lists HLS playlist URLs from the playing video and resource timing', () => {
    document.body.innerHTML = `
      <div data-testid="videoPlayer">
        <video id="playing">
          <source src="https://video.twimg.com/amplify_video/1/pl/playlist.m3u8" />
          <source src="/dummy.mp4" />
        </video>
      </div>
    `;
    const playing = document.querySelector('#playing') as HTMLVideoElement;
    expect(listXCaptionSourceUrls(playing)).toContain(
      'https://video.twimg.com/amplify_video/1/pl/playlist.m3u8',
    );
  });

  it('does not inherit leftover twimg resource timing when the video has no caption URLs', () => {
    document.body.innerHTML = '<video id="playing" src="/dummy.mp4"></video>';
    const playing = document.querySelector('#playing') as HTMLVideoElement;
    const view = playing.ownerDocument.defaultView;
    const original = view?.performance.getEntriesByType.bind(view.performance);
    if (view) {
      view.performance.getEntriesByType = (type: string) => {
        if (type !== 'resource') return original?.(type) ?? [];
        return [
          {
            name: 'https://video.twimg.com/subtitles/stale.vtt',
            duration: 0,
            entryType: 'resource',
            startTime: 0,
            toJSON() {
              return {};
            },
          },
        ] as PerformanceEntryList;
      };
    }
    expect(listXCaptionSourceUrls(playing)).toEqual([]);
    if (view && original) view.performance.getEntriesByType = original;
  });

  it('picks a spoken HLS subtitle rendition and reads native X caption DOM without mutating it', () => {
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Japanese",LANGUAGE="ja",URI="ja.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="subs"
video.m3u8
`;
    const renditions = parseHlsSubtitleRenditions(
      master,
      'https://video.twimg.com/amplify_video/1/pl/playlist.m3u8',
    );
    expect(renditions).toHaveLength(2);
    expect(pickXSubtitleRendition(renditions, 'ja')?.language).toBe('en');
    expect(
      parseHlsMediaSegments(
        '#EXTM3U\n#EXTINF:10,\nsegment.vtt\n',
        'https://video.twimg.com/subtitles/pl.m3u8',
      ),
    ).toEqual(['https://video.twimg.com/subtitles/segment.vtt']);

    document.body.innerHTML = `
      <div data-testid="videoPlayer">
        <div aria-live="polite" data-sakutto="x-native">The station opens at dawn.</div>
        <button type="button">Captions</button>
      </div>
    `;
    const native = document.querySelector('[data-sakutto="x-native"]') as HTMLElement;
    expect(readXCaptionDom(document)).toBe('The station opens at dawn.');
    expect(native.getAttribute('data-sakutto-native-caption')).toBeNull();

    document.body.innerHTML = `
      <div data-testid="videoPlayer" style="position:relative;width:320px;height:180px">
        <div
          class="css-hash"
          style="position:absolute;bottom:12px;color:rgb(255,255,255);text-shadow:rgb(0,0,0) 1px 1px 2px"
        >Tickets are sold at the north window.</div>
        <button type="button">Play</button>
      </div>
    `;
    expect(readXCaptionDom(document)).toBe('Tickets are sold at the north window.');
  });

  it('reads the active HTML5 cue when X paints captions off-DOM', () => {
    document.body.innerHTML = '<video id="player"></video>';
    const video = document.querySelector('#player') as HTMLVideoElement;
    const cue = { text: 'The station opens at dawn.' };
    Object.defineProperty(video, 'textTracks', {
      configurable: true,
      get: () => [
        {
          kind: 'subtitles',
          activeCues: [cue],
        },
      ],
    });
    expect(readXActiveCues(video)).toBe('The station opens at dawn.');
  });

  it('treats HAVE_METADATA as playing so inline MSE streams are not skipped', () => {
    document.body.innerHTML = '<video id="inline"></video>';
    const inline = document.querySelector('#inline') as HTMLVideoElement;
    stubVideo(inline, { paused: false, width: 320, height: 180, readyState: 1 });
    expect(pickPlayingXVideo(document)).toBe(inline);
    stubVideo(inline, { paused: false, width: 320, height: 180, readyState: 0 });
    expect(pickPlayingXVideo(document)).toBeNull();
  });
});

function stubVideo(
  video: HTMLVideoElement,
  options: { paused: boolean; width: number; height: number; readyState?: number },
): void {
  Object.defineProperty(video, 'paused', { configurable: true, get: () => options.paused });
  Object.defineProperty(video, 'ended', { configurable: true, get: () => false });
  Object.defineProperty(video, 'readyState', {
    configurable: true,
    get: () => options.readyState ?? 4,
  });
  Object.defineProperty(video, 'muted', { configurable: true, get: () => true });
  Object.defineProperty(video, 'volume', { configurable: true, get: () => 1 });
  video.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: options.width,
      bottom: options.height,
      width: options.width,
      height: options.height,
      toJSON() {
        return {};
      },
    }) as DOMRect;
}
