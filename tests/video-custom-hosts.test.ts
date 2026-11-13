import { describe, expect, it } from 'vitest';
import {
  captionCustomHostOrigins,
  hostMatchesCaptionCustom,
  normalizeCaptionCustomHosts,
  parseCaptionCustomHost,
} from '@/captions/custom-hosts';

describe('custom caption hosts', () => {
  it('accepts a domain or a leading subdomain wildcard', () => {
    expect(parseCaptionCustomHost('Example.COM')).toBe('example.com');
    expect(parseCaptionCustomHost('www.example.com')).toBe('example.com');
    expect(parseCaptionCustomHost('https://example.com')).toBe('example.com');
    expect(parseCaptionCustomHost('*.Example.com')).toBe('*.example.com');
  });

  it('rejects schemes, paths, and wildcards that are not a leading subdomain', () => {
    expect(parseCaptionCustomHost('file://example.com')).toBeNull();
    expect(parseCaptionCustomHost('chrome://settings')).toBeNull();
    expect(parseCaptionCustomHost('chrome-extension://abcd/options.html')).toBeNull();
    expect(parseCaptionCustomHost('example.com/watch')).toBeNull();
    expect(parseCaptionCustomHost('*')).toBeNull();
    expect(parseCaptionCustomHost('*.*')).toBeNull();
    expect(parseCaptionCustomHost('**')).toBeNull();
    expect(parseCaptionCustomHost('foo.*.example.com')).toBeNull();
    expect(parseCaptionCustomHost('*.com')).toBeNull();
    expect(parseCaptionCustomHost('*.jp')).toBeNull();
    expect(parseCaptionCustomHost('*.org')).toBeNull();
  });

  it('matches apex and subdomains only when requested', () => {
    expect(hostMatchesCaptionCustom('videos.example.com', ['example.com'])).toBe(false);
    expect(hostMatchesCaptionCustom('example.com', ['example.com'])).toBe(true);
    expect(hostMatchesCaptionCustom('videos.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatchesCaptionCustom('example.com', ['*.example.com'])).toBe(true);
    expect(captionCustomHostOrigins('*.example.com')).toEqual([
      'https://*.example.com/*',
      'http://*.example.com/*',
      'https://example.com/*',
      'http://example.com/*',
    ]);
  });

  it('normalizes a stored list without duplicates', () => {
    expect(
      normalizeCaptionCustomHosts(['Example.com', 'example.com', 'not a host', '*.ok.dev']),
    ).toEqual(['example.com', '*.ok.dev']);
    expect(normalizeCaptionCustomHosts('example.com')).toEqual([]);
  });
});
