// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  isTwimgSubtitleUrl,
  isXHost,
  listXSubtitleUrls,
  pickPlayingXVideo,
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
});

function stubVideo(
  video: HTMLVideoElement,
  options: { paused: boolean; width: number; height: number },
): void {
  Object.defineProperty(video, 'paused', { configurable: true, get: () => options.paused });
  Object.defineProperty(video, 'ended', { configurable: true, get: () => false });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
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
