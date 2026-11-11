import { describe, expect, it } from 'vitest';
import {
  captionPermissionOrigins,
  isCaptionAutoHost,
  resolveCaptionToggle,
  shouldAutoInjectCaptions,
} from '@/captions/sites';

describe('caption auto-run gating', () => {
  it('auto-injects only YouTube and X when the setting and origin grant are on', () => {
    expect(
      shouldAutoInjectCaptions({
        settingOn: true,
        host: 'www.youtube.com',
        originAllowed: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoInjectCaptions({
        settingOn: true,
        host: 'x.com',
        originAllowed: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoInjectCaptions({
        settingOn: false,
        host: 'www.youtube.com',
        originAllowed: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoInjectCaptions({
        settingOn: true,
        host: 'www.youtube.com',
        originAllowed: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoInjectCaptions({
        settingOn: true,
        host: 'example.com',
        originAllowed: true,
      }),
    ).toBe(false);
  });

  it('requests the existing optional page origins, not twimg', () => {
    const origins = captionPermissionOrigins();
    expect(origins.some((origin) => origin.includes('youtube.com'))).toBe(true);
    expect(origins.some((origin) => origin.includes('x.com'))).toBe(true);
    expect(origins.some((origin) => origin.includes('twitter.com'))).toBe(true);
    expect(origins.join(' ')).not.toContain('twimg.com');
    expect(isCaptionAutoHost('music.youtube.com')).toBe(true);
  });
});

describe('caption toggle permission gate', () => {
  it('turns off without requesting host access', async () => {
    let requested = 0;
    await expect(
      resolveCaptionToggle(false, async () => {
        requested += 1;
        return true;
      }),
    ).resolves.toEqual({ on: false, denied: false });
    expect(requested).toBe(0);
  });

  it('turns on after host access is granted', async () => {
    await expect(resolveCaptionToggle(true, async () => true)).resolves.toEqual({
      on: true,
      denied: false,
    });
  });

  it('reverts to off when the permission request is denied', async () => {
    await expect(resolveCaptionToggle(true, async () => false)).resolves.toEqual({
      on: false,
      denied: true,
    });
  });
});
