// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { CaptionOverlay } from '@/captions/overlay';

const labels = {
  label: 'Translated captions',
  pending: 'Translating caption…',
  showOriginal: 'Show original caption',
  hideOriginal: 'Hide original caption',
};

describe('caption overlay', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('shows the original while a translation is pending, then both lines in bilingual mode', () => {
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(document.body);
    overlay.show({
      original: 'The station opens at dawn.',
      translation: null,
      display: 'bilingual',
      pending: true,
    });

    const shadow = overlay.shadow();
    expect(shadow).not.toBeNull();
    const original = shadow?.querySelector('.original') as HTMLElement | null;
    const translated = shadow?.querySelector('.line:not(.original)') as HTMLElement | null;
    expect(original?.hidden).toBe(false);
    expect(original?.textContent).toBe('The station opens at dawn.');
    // Pending must not paint the status sentence over the video.
    expect(translated?.textContent).not.toBe('Translating caption…');
    expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-pending')).toBe(
      '1',
    );

    overlay.show({
      original: 'The station opens at dawn.',
      translation: '駅は夜明けに開きます。',
      display: 'bilingual',
      pending: false,
    });
    expect(original?.textContent).toBe('The station opens at dawn.');
    expect(translated?.textContent).toBe('駅は夜明けに開きます。');
    expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
      '駅は夜明けに開きます。',
    );
    expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
      'The station opens at dawn.',
    );
  });

  it('keeps the original when replace mode has no translation yet', () => {
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(document.body);
    overlay.show({
      original: 'Tickets are sold at the north window.',
      translation: null,
      display: 'replace',
      pending: false,
    });
    const shadow = overlay.shadow();
    const original = shadow?.querySelector('.original') as HTMLElement | null;
    const translated = shadow?.querySelector('.line:not(.original)') as HTMLElement | null;
    expect(original?.hidden).toBe(true);
    expect(translated?.hidden).toBe(false);
    expect(translated?.textContent).toBe('Tickets are sold at the north window.');
  });
});
