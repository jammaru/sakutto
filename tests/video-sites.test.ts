import { describe, expect, it } from 'vitest';
import {
  captionPermissionOrigins,
  isCaptionAutoHost,
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
