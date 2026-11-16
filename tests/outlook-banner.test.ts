// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  OUTLOOK_BANNER_TAG,
  OUTLOOK_MIN_BODY_CHARS,
  OutlookBannerController,
  detectOutlookMessageLanguage,
  findOutlookMessageBodies,
  isOutlookHost,
  initialOutlookBannerState,
  outlookBannerAfterDismiss,
  outlookBannerAfterShowOriginal,
  outlookBannerAfterShowTranslation,
  outlookBannerAfterTranslate,
  outlookBannerAfterTranslated,
  outlookBannerButton,
  outlookBannerShadow,
  outlookMessageKey,
  shouldAutoInjectOutlookBanner,
  shouldOfferOutlookTranslation,
  translateOutlookBody,
} from '@/dom/outlook-banner';
import { listTranslatableBlocks } from '@/dom/blocks';
import type { PageEngine } from '@/dom/session';
import { installEarlyMailBannerPresses } from '@/dom/mail-banner-press';

const labels = {
  region: 'Outlook message translation',
  detected: (language: string) => `This email appears to be written in ${language}.`,
  translate: (language: string) => `Translate to ${language}`,
  showOriginal: 'Show original',
  showTranslation: 'Show translation',
  translating: 'Translating this email…',
  error: 'Could not translate this email.',
  close: 'Close',
  translated: (source: string, target: string) => `Translated: ${source} → ${target}`,
  menu: 'Translation settings',
  translateNow: (language: string) => `Translate ${language}`,
  alwaysTranslate: (language: string) => `Always translate ${language}`,
  neverTranslate: (language: string) => `Never translate ${language}`,
};

const PREFERENCES = {
  enabled: true,
  targetLanguage: 'ja',
  form: 'polite' as const,
};

function body(html: string): HTMLElement {
  document.body.innerHTML = html;
  const element = document.querySelector<HTMLElement>('[role="document"]');
  if (!element) throw new Error('missing message body');
  return element;
}

function immediate(render: (text: string) => string = (text) => `§${text}`) {
  const engine: PageEngine = {
    async *translate(segments) {
      for (const segment of segments) {
        yield { id: segment.id, final: render(segment.text), engine: 'plamo' };
      }
    },
  };
  return engine;
}

function countingImmediate() {
  let calls = 0;
  return {
    calls: () => calls,
    engine: {
      async *translate(segments) {
        calls += segments.length;
        for (const segment of segments) {
          yield { id: segment.id, final: `§${segment.text}`, engine: 'plamo' };
        }
      },
    } satisfies PageEngine,
  };
}

function shadowButton(host: Element, label: string): HTMLButtonElement {
  const button = [...(outlookBannerShadow(host)?.querySelectorAll('button') ?? [])].find(
    (candidate) =>
      candidate.textContent === label || candidate.getAttribute('aria-label') === label,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`missing ${label}`);
  return button;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition did not settle');
}

const BANNER_PRESS_TYPES = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const;

function pressSequence(button: HTMLButtonElement): void {
  const init = { bubbles: true, composed: true, cancelable: true, button: 0 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const) {
    const event =
      typeof PointerEvent === 'function' && type.startsWith('pointer')
        ? new PointerEvent(type, init)
        : new MouseEvent(type, init);
    button.dispatchEvent(event);
  }
}

/** Simulates OWA's document capture listener swallowing every press phase. */
function swallowDocumentPresses(): () => void {
  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of BANNER_PRESS_TYPES) document.addEventListener(type, swallow, true);
  return () => {
    for (const type of BANNER_PRESS_TYPES) document.removeEventListener(type, swallow, true);
  };
}

const ENGLISH_MESSAGE = `
  <div data-convid="conv-1" id="message-1">
    <div role="document" aria-label="Message body" lang="en">
      <div dir="ltr">
        <p>Hi team, the release candidate is ready for review and we should ship it this week.</p>
      </div>
    </div>
  </div>
`;

const OWA_NEWSLETTER = `
  <div id="owa-app" lang="ja" translate="no">
    <div class="reading-pane" style="max-height: 480px; overflow-y: auto">
      <div data-convid="conv-news" id="message-news">
        <div
          id="UniqueMessageBody_1"
          class="OuGoX BIZfh"
          role="document"
          aria-label="メッセージ本文"
        >
          <div class="rps_0f4c1a">
            <div class="x_newsletter" style="max-width: 640px; margin: 0 auto">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tbody>
                  <tr><td><h1>Quarterly product update</h1></td></tr>
                  <tr>
                    <td>
                      <p>Hello everyone,</p>
                      <p>Welcome to the autumn newsletter. Our team shipped a new dashboard and improved search.</p>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <table role="presentation" width="100%">
                        <tbody>
                          <tr>
                            <td>
                              <h2>Release notes</h2>
                              <p>Read the <a href="https://example.com/notes">migration notes</a> before Friday.</p>
                            </td>
                            <td>
                              <h2>Events</h2>
                              <p>Join the <a href="https://example.com/events">customer webinar</a> next week.</p>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </td>
                  </tr>
                  <tr><td><p>Thanks,<br />Alex</p></td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
`;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Outlook host and message discovery', () => {
  it('limits the banner to Outlook web hosts', () => {
    for (const host of [
      'outlook.live.com',
      'outlook.office.com',
      'outlook.office365.com',
      'outlook.cloud.microsoft',
      'OUTLOOK.OFFICE.COM',
      'mail.outlook.office.com',
    ]) {
      expect(isOutlookHost(host), host).toBe(true);
    }
    for (const host of [
      'www.outlook.com',
      'outlook.com',
      'office.com',
      'notoutlook.office.com',
      'mail.google.com',
    ]) {
      expect(isOutlookHost(host), host).toBe(false);
    }
  });

  it('auto-injects only when the setting, Outlook host, and grant are on', () => {
    expect(
      shouldAutoInjectOutlookBanner({
        settingOn: true,
        host: 'outlook.office.com',
        originAllowed: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoInjectOutlookBanner({
        settingOn: false,
        host: 'outlook.office.com',
        originAllowed: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoInjectOutlookBanner({
        settingOn: true,
        host: 'outlook.office.com',
        originAllowed: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoInjectOutlookBanner({
        settingOn: true,
        host: 'example.com',
        originAllowed: true,
      }),
    ).toBe(false);
  });

  it('finds reading-pane bodies but not compose editors or hidden panes', () => {
    document.body.innerHTML = `
      <div data-convid="conv-1" id="message-1">
        <div role="document" aria-label="Message body">First message body</div>
      </div>
      <div contenteditable="true"><div role="document" aria-label="Message body">Draft</div></div>
      <div role="textbox"><div role="document" aria-label="Message body">Reply draft</div></div>
      <div aria-hidden="true"><div role="document" aria-label="Message body">Hidden preview</div></div>
      <div data-convid="conv-2" id="message-2">
        <div id="UniqueMessageBody_2" role="document">Second message body</div>
      </div>
    `;
    expect(findOutlookMessageBodies(document).map((element) => element.textContent)).toEqual([
      'First message body',
      'Second message body',
    ]);
  });

  it('keys a message by its explicit id, or by conversation plus message node id', () => {
    const explicit = body(
      '<div data-message-id="item-1"><div role="document" aria-label="Message body">Body</div></div>',
    );
    expect(outlookMessageKey(explicit)).toBe('item-1');

    const conversation = body(`
      <div data-convid="conv-9" id="message-node-9">
        <div role="document" aria-label="Message body">Body</div>
      </div>
    `);
    expect(outlookMessageKey(conversation)).toBe('conv-9:message-node-9');
  });
});

describe('Outlook language gating', () => {
  it('detects English prose without trusting the Outlook interface language', () => {
    document.documentElement.lang = 'ja';
    const element = body(ENGLISH_MESSAGE);
    expect(detectOutlookMessageLanguage(element, 'ja')).toBe('en');
    expect(
      shouldOfferOutlookTranslation({
        text: element.textContent ?? '',
        language: 'en',
        targetLanguage: 'ja',
      }),
    ).toBe(true);
  });

  it('prefers an explicit lang attribute in the message', () => {
    const element = body(`
      <div data-convid="conv-fr" id="message-fr">
        <div role="document" aria-label="Message body" lang="fr">
          Bonjour, la réunion est reportée à demain matin.
        </div>
      </div>
    `);
    expect(detectOutlookMessageLanguage(element, 'ja')).toBe('fr');
  });

  it('does not offer the banner for the target language or a short body', () => {
    expect(
      shouldOfferOutlookTranslation({
        text: 'This mail is already in Japanese and should not be offered again.',
        language: 'ja',
        targetLanguage: 'ja',
      }),
    ).toBe(false);
    expect(
      shouldOfferOutlookTranslation({
        text: '短い',
        language: 'en',
        targetLanguage: 'ja',
      }),
    ).toBe(false);
    expect(
      shouldOfferOutlookTranslation({
        text: 'x'.repeat(OUTLOOK_MIN_BODY_CHARS - 1),
        language: 'en',
        targetLanguage: 'ja',
      }),
    ).toBe(false);
    expect(
      shouldOfferOutlookTranslation({
        text: 'This body is long enough to look like real prose for the banner.',
        language: null,
        targetLanguage: 'ja',
      }),
    ).toBe(false);
  });
});

describe('Outlook banner state', () => {
  it('moves from offer to translating to translated and back', () => {
    const offer = initialOutlookBannerState();
    expect(outlookBannerButton(offer)).toBe('translate');
    const translating = outlookBannerAfterTranslate(offer);
    expect(outlookBannerButton(translating)).toBe('busy');
    const translated = outlookBannerAfterTranslated(translating);
    expect(outlookBannerButton(translated)).toBe('show-original');
    const original = outlookBannerAfterShowOriginal(translated);
    expect(outlookBannerButton(original)).toBe('show-translation');
    expect(outlookBannerButton(outlookBannerAfterShowTranslation(original))).toBe('show-original');
    expect(outlookBannerAfterShowOriginal(original)).toBe(original);
    expect(outlookBannerAfterShowTranslation(translated)).toBe(translated);
  });

  it('removes the button after a dismiss and ignores later transitions', () => {
    const dismissed = outlookBannerAfterDismiss(initialOutlookBannerState());
    expect(outlookBannerButton(dismissed)).toBeNull();
    expect(outlookBannerAfterTranslate(dismissed)).toBe(dismissed);
    expect(outlookBannerAfterTranslated(dismissed)).toBe(dismissed);
    expect(outlookBannerAfterShowOriginal(dismissed)).toBe(dismissed);
    expect(outlookBannerAfterShowTranslation(dismissed)).toBe(dismissed);
  });
});

describe('Outlook banner controller', () => {
  it('mounts above a foreign-language body and translates only after a click', async () => {
    const element = body(ENGLISH_MESSAGE);
    const original = element.textContent;
    const counted = countingImmediate();
    const controller = new OutlookBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: PREFERENCES,
    });
    controller.start();

    const host = element.previousElementSibling;
    expect(host?.tagName).toBe(OUTLOOK_BANNER_TAG.toUpperCase());
    expect(host?.getAttribute('data-sakutto-outlook-phase')).toBe('offer');
    expect(host?.getAttribute('data-sakutto-outlook-banner')).toBe('conv-1:message-1');
    expect(element.textContent).toBe(original);
    expect(counted.calls()).toBe(0);

    shadowButton(host!, 'Translate to ja').click();
    await waitFor(() => host?.getAttribute('data-sakutto-outlook-phase') === 'translated');
    expect(element.textContent).toContain(
      '§Hi team, the release candidate is ready for review and we should ship it this week.',
    );
    expect(shadowButton(host!, 'Show original')).toBeDefined();

    shadowButton(host!, 'Show original').click();
    await waitFor(() => host?.getAttribute('data-sakutto-outlook-phase') === 'original');
    expect(element.textContent).toBe(original);
    expect(shadowButton(host!, 'Show translation')).toBeDefined();
    controller.dispose();
  });

  it('reapplies a cached translation from Show translation without another request', async () => {
    const element = body(ENGLISH_MESSAGE);
    const original = element.textContent;
    const counted = countingImmediate();
    const controller = new OutlookBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    shadowButton(host!, 'Translate to ja').click();
    await waitFor(() => host?.getAttribute('data-sakutto-outlook-phase') === 'translated');
    const callsAfterTranslate = counted.calls();
    expect(callsAfterTranslate).toBeGreaterThan(0);
    expect(element.textContent).toContain('§Hi team, the release candidate');

    shadowButton(host!, 'Show original').click();
    expect(host?.getAttribute('data-sakutto-outlook-phase')).toBe('original');
    expect(element.textContent).toBe(original);

    shadowButton(host!, 'Show translation').click();
    expect(host?.getAttribute('data-sakutto-outlook-phase')).toBe('translated');
    expect(element.textContent).toContain('§Hi team, the release candidate');
    expect(counted.calls()).toBe(callsAfterTranslate);
    controller.dispose();
  });

  it('auto-translates a remembered source language without offering first', async () => {
    const element = body(ENGLISH_MESSAGE);
    const counted = countingImmediate();
    const controller = new OutlookBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: { ...PREFERENCES, autoLanguages: ['en'] },
    });
    controller.start();
    const host = element.previousElementSibling;
    await waitFor(() => host?.getAttribute('data-sakutto-outlook-phase') === 'translated');
    expect(element.textContent).toContain('§Hi team, the release candidate');
    expect(counted.calls()).toBeGreaterThan(0);

    const calls = counted.calls();
    controller.refresh();
    controller.refresh();
    expect(counted.calls()).toBe(calls);
    expect(host?.getAttribute('data-sakutto-outlook-phase')).toBe('translated');
    controller.dispose();
  });

  it('mounts one banner when two content-script instances initialize the same frame', () => {
    const element = body(ENGLISH_MESSAGE);
    const first = new OutlookBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    const second = new OutlookBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    try {
      first.start();
      second.start();
      expect(document.querySelectorAll(OUTLOOK_BANNER_TAG)).toHaveLength(1);

      second.refresh();
      const host = element.previousElementSibling;
      expect(document.querySelectorAll(OUTLOOK_BANNER_TAG)).toHaveLength(1);
      expect(host?.localName).toBe(OUTLOOK_BANNER_TAG);
      expect(outlookBannerShadow(host)?.querySelector('.text')?.textContent).toBe(
        'This email appears to be written in en.',
      );
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('skips a message whose source language is on the never list', () => {
    body(ENGLISH_MESSAGE);
    const counted = countingImmediate();
    const controller = new OutlookBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: { ...PREFERENCES, neverLanguages: ['en'] },
    });
    controller.start();
    expect(document.querySelector(OUTLOOK_BANNER_TAG)).toBeNull();
    controller.refresh();
    expect(document.querySelector(OUTLOOK_BANNER_TAG)).toBeNull();
    expect(counted.calls()).toBe(0);
    controller.dispose();
  });

  it('opens the gear menu with aria-expanded and closes it with Escape', () => {
    const element = body(ENGLISH_MESSAGE);
    const controller = new OutlookBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    const shadow = outlookBannerShadow(host);
    if (!shadow) throw new Error('missing shadow');
    const gear = shadow.querySelector<HTMLButtonElement>('.gear');
    const menu = shadow.querySelector<HTMLElement>('[role="menu"]');
    if (!gear || !menu) throw new Error('missing menu');

    expect(gear.getAttribute('aria-expanded')).toBe('false');
    expect(menu.hidden).toBe(true);
    gear.click();
    expect(gear.getAttribute('aria-expanded')).toBe('true');
    expect(menu.hidden).toBe(false);

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(gear.getAttribute('aria-expanded')).toBe('false');
    expect(menu.hidden).toBe(true);
    controller.dispose();
  });

  it('persists shared always/never choices from the menu with checkmarks', () => {
    const element = body(ENGLISH_MESSAGE);
    const changes: { auto: string[]; never: string[] }[] = [];
    const controller = new OutlookBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
      onLanguagesChange: (next) => changes.push(next),
    });
    controller.start();
    const host = element.previousElementSibling;
    const shadow = outlookBannerShadow(host);
    if (!shadow) throw new Error('missing shadow');
    shadow.querySelector<HTMLButtonElement>('.gear')?.click();
    const always = shadow.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]');
    if (!always) throw new Error('missing always item');
    expect(always.getAttribute('aria-checked')).toBe('false');
    expect(always.textContent).toContain('Always translate en');
    always.click();
    expect(changes.at(-1)).toEqual({ auto: ['en'], never: [] });
    expect(always.getAttribute('aria-checked')).toBe('true');

    shadow.querySelector<HTMLButtonElement>('.gear')?.click();
    const never = shadow.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')[1];
    if (!never) throw new Error('missing never item');
    never.click();
    expect(changes.at(-1)).toEqual({ auto: [], never: ['en'] });
    expect(document.querySelector(OUTLOOK_BANNER_TAG)).toBeNull();
    controller.dispose();
  });

  it('does not mount or translate anything when the global switch is off', () => {
    body(ENGLISH_MESSAGE);
    const counted = countingImmediate();
    const controller = new OutlookBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: { ...PREFERENCES, enabled: false, autoLanguages: ['en'] },
    });
    controller.start();
    expect(document.querySelector(OUTLOOK_BANNER_TAG)).toBeNull();
    expect(counted.calls()).toBe(0);
    controller.dispose();
  });

  it('uses a light and dark Outlook-style banner', () => {
    const element = body(ENGLISH_MESSAGE);
    const controller = new OutlookBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    const style = outlookBannerShadow(host)?.querySelector('style')?.textContent ?? '';
    expect(style).toContain('@media (prefers-color-scheme: dark)');
    expect(style).toContain('#0f6cbd');
    expect(style).toContain('"Segoe UI"');
    controller.dispose();
  });

  it('hides the banner for that message after close and restores the body', async () => {
    const element = body(ENGLISH_MESSAGE);
    const original = element.textContent;
    const controller = new OutlookBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    shadowButton(host!, 'Translate to ja').click();
    await waitFor(() => host?.getAttribute('data-sakutto-outlook-phase') === 'translated');
    expect(element.textContent).toContain('§Hi team, the release candidate');

    shadowButton(host!, 'Close').click();
    expect(document.querySelector(OUTLOOK_BANNER_TAG)).toBeNull();
    expect(element.textContent).toBe(original);
    controller.refresh();
    expect(document.querySelector(OUTLOOK_BANNER_TAG)).toBeNull();
    controller.dispose();
  });

  it('adds a banner when Outlook expands a message later', async () => {
    document.body.innerHTML = '<div id="reading-pane"></div>';
    const controller = new OutlookBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
      debounceMs: 1,
    });
    controller.start();
    const pane = document.querySelector('#reading-pane');
    if (!pane) throw new Error('missing reading pane');
    pane.innerHTML = `
      <div data-convid="late" id="message-late">
        <div role="document" aria-label="Message body" lang="en">
          A message loaded after the first scan of the reading pane.
        </div>
      </div>
    `;
    await waitFor(() => document.querySelector(OUTLOOK_BANNER_TAG) !== null);
    controller.dispose();
  });
  it('keeps controls working when OWA swallows document-level pointer events', async () => {
    const stopSwallowing = swallowDocumentPresses();
    try {
      const element = body(ENGLISH_MESSAGE);
      const original = element.textContent;
      const controller = new OutlookBannerController(document, {
        engine: immediate(),
        labels,
        preferences: PREFERENCES,
      });
      controller.start();
      const host = element.previousElementSibling;
      if (!host) throw new Error('missing banner');

      pressSequence(shadowButton(host, 'Translate to ja'));
      await waitFor(() => host.getAttribute('data-sakutto-outlook-phase') === 'translated');
      expect(element.textContent).toContain('§Hi team, the release candidate');

      pressSequence(shadowButton(host, 'Show original'));
      expect(host.getAttribute('data-sakutto-outlook-phase')).toBe('original');
      expect(element.textContent).toBe(original);

      pressSequence(shadowButton(host, 'Show translation'));
      expect(host.getAttribute('data-sakutto-outlook-phase')).toBe('translated');
      expect(element.textContent).toContain('§Hi team, the release candidate');

      pressSequence(shadowButton(host, 'Close'));
      expect(document.querySelector(OUTLOOK_BANNER_TAG)).toBeNull();
      expect(element.textContent).toBe(original);
      controller.dispose();
    } finally {
      stopSwallowing();
    }
  });

  it('forwards a press from the document_start bridge before OWA window capture', async () => {
    const uninstall = installEarlyMailBannerPresses(window);
    const swallow = (event: Event): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const type of BANNER_PRESS_TYPES) window.addEventListener(type, swallow, true);
    const controller = new OutlookBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    try {
      const element = body(ENGLISH_MESSAGE);
      controller.start();
      const host = element.previousElementSibling;
      if (!host) throw new Error('missing banner');

      pressSequence(shadowButton(host, 'Translate to ja'));
      await waitFor(() => host.getAttribute('data-sakutto-outlook-phase') === 'translated');
      expect(element.textContent).toContain('§Hi team, the release candidate');
    } finally {
      controller.dispose();
      for (const type of BANNER_PRESS_TYPES) window.removeEventListener(type, swallow, true);
      uninstall();
    }
  });

  it('acts on pointerup when OWA swallowed the pointerdown before the banner', async () => {
    const swallowDown = (event: Event): void => {
      if (event.type === 'pointerdown') event.stopImmediatePropagation();
    };
    window.addEventListener('pointerdown', swallowDown, true);
    const controller = new OutlookBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    try {
      const element = body(ENGLISH_MESSAGE);
      controller.start();
      const host = element.previousElementSibling;
      if (!host) throw new Error('missing banner');
      const button = shadowButton(host, 'Translate to ja');
      const init = { bubbles: true, composed: true, cancelable: true, button: 0 };
      button.dispatchEvent(
        typeof PointerEvent === 'function'
          ? new PointerEvent('pointerdown', init)
          : new MouseEvent('pointerdown', init),
      );
      expect(host.getAttribute('data-sakutto-outlook-phase')).toBe('offer');
      button.dispatchEvent(
        typeof PointerEvent === 'function'
          ? new PointerEvent('pointerup', init)
          : new MouseEvent('pointerup', init),
      );
      await waitFor(() => host.getAttribute('data-sakutto-outlook-phase') === 'translated');
      expect(element.textContent).toContain('§Hi team, the release candidate');
    } finally {
      controller.dispose();
      window.removeEventListener('pointerdown', swallowDown, true);
    }
  });

  it('resolves a replaced body when the translation is requested', async () => {
    const element = body(ENGLISH_MESSAGE);
    const counted = countingImmediate();
    const controller = new OutlookBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    if (!host) throw new Error('missing banner');

    const replacement = element.cloneNode(true) as HTMLElement;
    replacement.setAttribute('data-owa-rerender', '1');
    element.replaceWith(replacement);
    expect(host.nextElementSibling).toBe(replacement);

    pressSequence(shadowButton(host, 'Translate to ja'));
    await waitFor(() => host.getAttribute('data-sakutto-outlook-phase') === 'translated');
    expect(replacement.textContent).toContain('§Hi team, the release candidate');
    expect(counted.calls()).toBeGreaterThan(0);
    controller.dispose();
  });

  it('translates a body replaced while the engine is still working', async () => {
    const element = body(ENGLISH_MESSAGE);
    const fresh = element.cloneNode(true) as HTMLElement;
    fresh.setAttribute('data-owa-rerender', '1');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments) {
        await gate;
        for (const segment of segments) {
          yield { id: segment.id, final: `§${segment.text}`, engine: 'plamo' };
        }
      },
    };
    const controller = new OutlookBannerController(document, {
      engine,
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    if (!host) throw new Error('missing banner');

    pressSequence(shadowButton(host, 'Translate to ja'));
    await waitFor(() => host.getAttribute('data-sakutto-outlook-phase') === 'translating');
    element.replaceWith(fresh);
    release();

    await waitFor(() => host.getAttribute('data-sakutto-outlook-phase') === 'translated');
    expect(host.nextElementSibling).toBe(fresh);
    expect(fresh.textContent).toContain('§Hi team, the release candidate');
    expect(element.textContent).not.toContain('§Hi team, the release candidate');
    controller.dispose();
  });

  it('reapplies the cached translation when OWA replaces the body afterwards', async () => {
    const element = body(ENGLISH_MESSAGE);
    const fresh = element.cloneNode(true) as HTMLElement;
    fresh.setAttribute('data-owa-rerender', '1');
    const counted = countingImmediate();
    const controller = new OutlookBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    if (!host) throw new Error('missing banner');
    pressSequence(shadowButton(host, 'Translate to ja'));
    await waitFor(() => host.getAttribute('data-sakutto-outlook-phase') === 'translated');
    const calls = counted.calls();
    expect(element.textContent).toContain('§Hi team, the release candidate');

    element.replaceWith(fresh);
    controller.refresh();

    expect(host.isConnected).toBe(true);
    expect(host.nextElementSibling).toBe(fresh);
    expect(host.getAttribute('data-sakutto-outlook-phase')).toBe('translated');
    expect(fresh.textContent).toContain('§Hi team, the release candidate');
    expect(counted.calls()).toBe(calls);
    controller.dispose();
  });

  it('updates the busy banner and applies each block as its job finishes', async () => {
    const element = body(`
      <div data-convid="conv-progress" id="message-progress">
        <div role="document" aria-label="Message body" lang="en">
          <p>First paragraph for the newsletter progress check.</p>
          <p>Second paragraph arrives after the first job finishes.</p>
        </div>
      </div>
    `);
    const gates: (() => void)[] = [];
    const engine: PageEngine = {
      async *translate(segments) {
        for (const segment of segments) {
          await new Promise<void>((resolve) => gates.push(resolve));
          yield { id: segment.id, final: `§${segment.text}`, engine: 'plamo' };
        }
      },
    };
    const controller = new OutlookBannerController(document, {
      engine,
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    if (!host) throw new Error('missing banner');
    const text = outlookBannerShadow(host)?.querySelector('.text');
    if (!text) throw new Error('missing banner text');

    pressSequence(shadowButton(host, 'Translate to ja'));
    await waitFor(() => gates.length > 0);
    expect(host.getAttribute('data-sakutto-outlook-phase')).toBe('translating');
    expect(text.textContent).toContain('0%');

    gates.shift()?.();
    await waitFor(() => element.textContent?.includes('§First paragraph') ?? false);
    expect(host.getAttribute('data-sakutto-outlook-phase')).toBe('translating');
    expect(text.textContent).toContain('50%');
    expect(element.textContent).not.toContain('§Second paragraph');

    gates.shift()?.();
    await waitFor(() => host.getAttribute('data-sakutto-outlook-phase') === 'translated');
    expect(element.textContent).toContain('§Second paragraph');
    controller.dispose();
  });

  it('shows a brief error state when translation fails', async () => {
    const element = body(ENGLISH_MESSAGE);
    const controller = new OutlookBannerController(document, {
      engine: {
        async *translate() {
          yield* [];
          throw new Error('engine failed');
        },
      },
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    if (!host) throw new Error('missing banner');

    pressSequence(shadowButton(host, 'Translate to ja'));
    await waitFor(() => host.getAttribute('data-sakutto-outlook-phase') === 'error');
    expect(outlookBannerShadow(host)?.querySelector('.text')?.textContent).toBe(labels.error);
    const action = outlookBannerShadow(host)?.querySelector<HTMLButtonElement>('.action');
    expect(action?.disabled).toBe(true);
    controller.dispose();
  });

  it('runs every gear-menu item when OWA swallows document-level pointer events', async () => {
    const stopSwallowing = swallowDocumentPresses();
    try {
      const element = body(ENGLISH_MESSAGE);
      const changes: { auto: string[]; never: string[] }[] = [];
      const controller = new OutlookBannerController(document, {
        engine: immediate(),
        labels,
        preferences: PREFERENCES,
        onLanguagesChange: (next) => changes.push(next),
      });
      controller.start();
      const host = element.previousElementSibling;
      const shadow = outlookBannerShadow(host);
      if (!host || !shadow) throw new Error('missing banner');
      const gear = shadow.querySelector<HTMLButtonElement>('.gear');
      const menu = shadow.querySelector<HTMLElement>('[role="menu"]');
      const translateNow = shadow.querySelector<HTMLButtonElement>('[role="menuitem"]');
      const auto = shadow.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')[0];
      const never = shadow.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')[1];
      if (!gear || !menu || !translateNow || !auto || !never) throw new Error('missing menu item');

      pressSequence(gear);
      expect(gear.getAttribute('aria-expanded')).toBe('true');
      expect(menu.hidden).toBe(false);
      pressSequence(translateNow);
      await waitFor(() => host.getAttribute('data-sakutto-outlook-phase') === 'translated');
      expect(menu.hidden).toBe(true);

      pressSequence(gear);
      pressSequence(auto);
      expect(changes.at(-1)).toEqual({ auto: ['en'], never: [] });
      expect(menu.hidden).toBe(true);

      pressSequence(gear);
      pressSequence(never);
      expect(changes.at(-1)).toEqual({ auto: [], never: ['en'] });
      expect(document.querySelector(OUTLOOK_BANNER_TAG)).toBeNull();
      controller.dispose();
    } finally {
      stopSwallowing();
    }
  });
});

describe('Outlook body translation', () => {
  it('translates an OWA newsletter under a Japanese app shell and table layout', async () => {
    const element = body(OWA_NEWSLETTER);
    const blocks = listTranslatableBlocks(element);
    const texts = blocks.map((block) => (block.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(texts).toContain('Quarterly product update');
    expect(texts).toContain('Read the migration notes before Friday.');
    expect(texts).toContain('Join the customer webinar next week.');

    const progress: { totalBlocks: number; completedBlocks: number; appliedBlocks: number }[] = [];
    const applied = await translateOutlookBody(element, immediate(), {
      targetLanguage: 'ja',
      form: 'polite',
      language: 'en',
      signal: new AbortController().signal,
      onProgress: (next) => progress.push(next),
    });

    expect(applied.length).toBeGreaterThan(0);
    expect(progress[0]).toMatchObject({ completedBlocks: 0 });
    expect(progress.at(-1)?.completedBlocks).toBe(progress.at(-1)?.totalBlocks);
    expect(progress.at(-1)?.appliedBlocks).toBe(applied.length);
    expect(element.textContent).toContain('§Quarterly product update');
    expect(element.textContent).toContain('§Read the');
    expect(element.textContent).toContain('§Join the');
    expect(element.querySelectorAll('table')).toHaveLength(2);
    expect(element.querySelector('a')?.getAttribute('href')).toBe('https://example.com/notes');
  });

  it('leaves a body in the target language alone', async () => {
    const element = body(`
      <div data-convid="conv-ja" id="message-ja">
        <div role="document" aria-label="Message body">
          これは日本語のメールなので翻訳する必要はありません。
        </div>
      </div>
    `);
    const before = element.innerHTML;
    const applied = await translateOutlookBody(element, immediate(), {
      targetLanguage: 'ja',
      form: 'polite',
      language: 'ja',
      signal: new AbortController().signal,
    });
    expect(applied).toHaveLength(0);
    expect(element.innerHTML).toBe(before);
  });
});
