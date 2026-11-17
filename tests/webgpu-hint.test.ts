import { describe, expect, it } from 'vitest';
import { isLinuxPlatform } from '@/shared/browser';
import { linuxWebGpuHintKey, linuxWebGpuHintVisible } from '@/shared/webgpu-hint';

const linuxX11 = {
  userAgentData: { platform: 'Linux' },
  platform: 'Linux x86_64',
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

describe('isLinuxPlatform', () => {
  it('recognizes a Linux X11 desktop', () => {
    expect(isLinuxPlatform(linuxX11)).toBe(true);
  });

  it('falls back to navigator.platform when userAgentData is missing', () => {
    expect(
      isLinuxPlatform({
        platform: 'Linux x86_64',
        userAgent: linuxX11.userAgent,
      }),
    ).toBe(true);
  });

  it('does not treat Android as a Linux desktop', () => {
    expect(
      isLinuxPlatform({
        platform: 'Linux armv8l',
        userAgent:
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      }),
    ).toBe(false);
  });

  it('does not match macOS or Windows', () => {
    expect(
      isLinuxPlatform({
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      }),
    ).toBe(false);
    expect(
      isLinuxPlatform({
        platform: 'Win32',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      }),
    ).toBe(false);
  });
});

describe('Linux WebGPU hint', () => {
  it.each([
    ['unsupported', 'engineLinuxWebGpuHintUnsupported'],
    ['unavailable', 'engineLinuxWebGpuHintUnavailable'],
  ] as const)('maps %s to its own hint', (webgpu, key) => {
    expect(linuxWebGpuHintKey(webgpu)).toBe(key);
  });

  it.each(['ready', 'failed', null] as const)('has no hint when WebGPU is %s', (webgpu) => {
    expect(linuxWebGpuHintKey(webgpu)).toBeNull();
  });

  it.each(['unsupported', 'unavailable'] as const)(
    'shows on Chrome Linux when WebGPU is %s',
    (webgpu) => {
      expect(linuxWebGpuHintVisible(webgpu, { browser: 'chrome', linux: true })).toBe(true);
    },
  );

  it.each(['ready', 'failed', null] as const)('stays hidden when WebGPU is %s', (webgpu) => {
    expect(linuxWebGpuHintVisible(webgpu, { browser: 'chrome', linux: true })).toBe(false);
  });

  it('stays hidden outside Chrome or outside Linux', () => {
    expect(linuxWebGpuHintVisible('unsupported', { browser: 'firefox', linux: true })).toBe(false);
    expect(linuxWebGpuHintVisible('unsupported', { browser: 'chrome', linux: false })).toBe(false);
  });
});
