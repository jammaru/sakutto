// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension-id',
    },
  },
}));

import {
  GMAIL_BANNER_TAG,
  GMAIL_MIN_BODY_CHARS,
  GmailBannerController,
  detectGmailMessageLanguage,
  findGmailMessageBodies,
  gmailBannerAfterDismiss,
  gmailBannerAfterShowOriginal,
  gmailBannerAfterShowTranslation,
  gmailBannerAfterTranslate,
  gmailBannerAfterTranslated,
  gmailBannerButton,
  gmailBannerShadow,
  gmailMessageKey,
  initialGmailBannerState,
  isGmailHost,
  shouldAutoInjectGmailBanner,
  shouldOfferGmailTranslation,
  toggleGmailAutoTranslateLanguage,
  toggleGmailNeverTranslateLanguage,
  translateGmailBody,
} from '@/dom/gmail-banner';
import type { PageEngine } from '@/dom/session';

const labels = {
  region: 'Gmail message translation',
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
  const element = document.querySelector<HTMLElement>('div.a3s');
  if (!element) throw new Error('missing message body');
  return element;
}

function immediate(render: (text: string, target: string) => string = (text) => `§${text}`) {
  const engine: PageEngine = {
    async *translate(segments, options) {
      for (const segment of segments) {
        yield { id: segment.id, final: render(segment.text, options.tgt), engine: 'plamo' };
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
  const button = [...(gmailBannerShadow(host)?.querySelectorAll('button') ?? [])].find(
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

const BANNER_PRESS_TYPES = ['pointerdown', 'mousedown', 'click'] as const;

function pressSequence(button: HTMLButtonElement): void {
  const init = { bubbles: true, composed: true, cancelable: true, button: 0 };
  const pointer =
    typeof PointerEvent === 'function'
      ? new PointerEvent('pointerdown', init)
      : new MouseEvent('pointerdown', init);
  button.dispatchEvent(pointer);
  for (const type of ['mousedown', 'click'] as const) {
    button.dispatchEvent(new MouseEvent(type, init));
  }
}

/** Simulates OWA's document capture listener swallowing every press phase. */
function swallowDocumentPresses(): () => void {
  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  for (const type of BANNER_PRESS_TYPES) document.addEventListener(type, swallow, true);
  return () => {
    for (const type of BANNER_PRESS_TYPES) document.removeEventListener(type, swallow, true);
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Gmail host and message discovery', () => {
  it('limits the banner to Gmail hosts', () => {
    expect(isGmailHost('mail.google.com')).toBe(true);
    expect(isGmailHost('MAIL.GOOGLE.COM')).toBe(true);
    expect(isGmailHost('inbox.mail.google.com')).toBe(true);
    expect(isGmailHost('www.google.com')).toBe(false);
    expect(isGmailHost('notmail.google.com')).toBe(false);
  });

  it('auto-injects only when the setting and host grant are on', () => {
    expect(
      shouldAutoInjectGmailBanner({
        settingOn: true,
        host: 'mail.google.com',
        originAllowed: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoInjectGmailBanner({
        settingOn: false,
        host: 'mail.google.com',
        originAllowed: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoInjectGmailBanner({
        settingOn: true,
        host: 'mail.google.com',
        originAllowed: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoInjectGmailBanner({
        settingOn: true,
        host: 'example.com',
        originAllowed: true,
      }),
    ).toBe(false);
  });

  it('finds message bodies but not compose editors', () => {
    document.body.innerHTML = `
      <div data-message-id="m1"><div class="a3s aiL">First message body</div></div>
      <div contenteditable="true"><div class="a3s aiL">Draft in a compose editor</div></div>
      <div role="textbox"><div class="a3s aiL">Reply draft</div></div>
      <div data-message-id="m2"><div class="a3s aiL">Second message body</div></div>
    `;
    expect(findGmailMessageBodies(document).map((element) => element.textContent)).toEqual([
      'First message body',
      'Second message body',
    ]);
  });

  it('reads a message id from the surrounding row', () => {
    const element = body(
      '<div data-message-id="thread-1"><div class="a3s aiL">Body with an id</div></div>',
    );
    expect(gmailMessageKey(element)).toBe('thread-1');
  });
});

describe('Gmail language gating', () => {
  it('detects English prose without trusting the Gmail interface language', () => {
    const element = body(`
      <div class="a3s aiL">
        <div>Hi team, the release is ready for review and we should ship it this week.</div>
      </div>
    `);
    expect(detectGmailMessageLanguage(element, 'ja')).toBe('en');
    expect(
      shouldOfferGmailTranslation({
        text: element.textContent ?? '',
        language: 'en',
        targetLanguage: 'ja',
      }),
    ).toBe(true);
  });

  it('prefers an explicit lang attribute in the message', () => {
    const element = body(`
      <div class="a3s aiL" lang="fr">
        <div>Bonjour, la réunion est reportée à demain matin.</div>
      </div>
    `);
    expect(detectGmailMessageLanguage(element, 'ja')).toBe('fr');
  });

  it('does not offer the banner for the target language or for a short body', () => {
    expect(
      shouldOfferGmailTranslation({
        text: 'This email is already in Japanese and should not be offered again.',
        language: 'ja',
        targetLanguage: 'ja',
      }),
    ).toBe(false);
    expect(
      shouldOfferGmailTranslation({
        text: '短い',
        language: 'ja',
        targetLanguage: 'en',
      }),
    ).toBe(false);
    expect(
      shouldOfferGmailTranslation({
        text: 'x'.repeat(GMAIL_MIN_BODY_CHARS - 1),
        language: 'en',
        targetLanguage: 'ja',
      }),
    ).toBe(false);
    expect(
      shouldOfferGmailTranslation({
        text: 'This body is long enough to look like real prose for the banner.',
        language: null,
        targetLanguage: 'ja',
      }),
    ).toBe(false);
  });

  it('treats Easy Japanese as Japanese for this banner', () => {
    expect(
      shouldOfferGmailTranslation({
        text: 'これは日本語のメールなので、同じ言語として扱います。',
        language: 'ja',
        targetLanguage: 'ja-easy',
      }),
    ).toBe(false);
  });

  it('does not use the interface language as the message language', () => {
    document.documentElement.lang = 'ja';
    const element = body(`
      <div class="a3s aiL">
        <div>Please review the attached proposal before Friday.</div>
      </div>
    `);
    expect(detectGmailMessageLanguage(element, 'ja')).toBe('en');
  });
});

describe('Gmail banner state', () => {
  it('moves from offer to translating to translated and back', () => {
    const offer = initialGmailBannerState();
    expect(gmailBannerButton(offer)).toBe('translate');
    const translating = gmailBannerAfterTranslate(offer);
    expect(gmailBannerButton(translating)).toBe('busy');
    const translated = gmailBannerAfterTranslated(translating);
    expect(gmailBannerButton(translated)).toBe('show-original');
    const original = gmailBannerAfterShowOriginal(translated);
    expect(gmailBannerButton(original)).toBe('show-translation');
    expect(gmailBannerButton(gmailBannerAfterShowTranslation(original))).toBe('show-original');
    expect(gmailBannerAfterShowOriginal(original)).toBe(original);
    expect(gmailBannerAfterShowTranslation(translated)).toBe(translated);
  });

  it('removes the button after a dismiss and ignores later transitions', () => {
    const dismissed = gmailBannerAfterDismiss(initialGmailBannerState());
    expect(gmailBannerButton(dismissed)).toBeNull();
    expect(gmailBannerAfterTranslate(dismissed)).toBe(dismissed);
    expect(gmailBannerAfterTranslated(dismissed)).toBe(dismissed);
    expect(gmailBannerAfterShowOriginal(dismissed)).toBe(dismissed);
    expect(gmailBannerAfterShowTranslation(dismissed)).toBe(dismissed);
  });

  it('keeps the translated phase when dismissed so the controller can restore the body', () => {
    const translated = gmailBannerAfterTranslated(
      gmailBannerAfterTranslate(initialGmailBannerState()),
    );
    const dismissed = gmailBannerAfterDismiss(translated);
    expect(dismissed).toEqual({ phase: 'translated', dismissed: true });
    expect(gmailBannerButton(dismissed)).toBeNull();
  });
});

describe('Gmail banner controller', () => {
  it('mounts above a foreign-language body and translates only after a click', async () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL">
          <div>Hi team, the release is ready for review and we should ship it this week.</div>
        </div>
      </div>
    `);
    const original = element.textContent;
    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();

    const host = element.previousElementSibling;
    expect(host?.tagName).toBe(GMAIL_BANNER_TAG.toUpperCase());
    expect(host?.getAttribute('data-sakutto-gmail-phase')).toBe('offer');
    expect(element.textContent).toBe(original);

    shadowButton(host!, 'Translate to ja').click();
    await waitFor(() => host?.getAttribute('data-sakutto-gmail-phase') === 'translated');
    expect(element.textContent).toContain(
      '§Hi team, the release is ready for review and we should ship it this week.',
    );
    expect(shadowButton(host!, 'Show original')).toBeDefined();

    shadowButton(host!, 'Show original').click();
    await waitFor(() => host?.getAttribute('data-sakutto-gmail-phase') === 'original');
    expect(element.textContent).toBe(original);
    expect(shadowButton(host!, 'Show translation')).toBeDefined();
    controller.dispose();
  });

  it('reapplies a cached translation from Show translation without another request', async () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const original = element.textContent;
    const counted = countingImmediate();
    const controller = new GmailBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    shadowButton(host!, 'Translate to ja').click();
    await waitFor(() => host?.getAttribute('data-sakutto-gmail-phase') === 'translated');
    const callsAfterTranslate = counted.calls();
    expect(callsAfterTranslate).toBeGreaterThan(0);
    expect(element.textContent).toContain('§Hi team, the release is ready for review');

    shadowButton(host!, 'Show original').click();
    expect(host?.getAttribute('data-sakutto-gmail-phase')).toBe('original');
    expect(element.textContent).toBe(original);

    shadowButton(host!, 'Show translation').click();
    expect(host?.getAttribute('data-sakutto-gmail-phase')).toBe('translated');
    expect(element.textContent).toContain('§Hi team, the release is ready for review');
    expect(counted.calls()).toBe(callsAfterTranslate);
    controller.dispose();
  });

  it('restores translation from the menu while viewing the original', async () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const original = element.textContent;
    const counted = countingImmediate();
    const controller = new GmailBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    shadowButton(host!, 'Translate to ja').click();
    await waitFor(() => host?.getAttribute('data-sakutto-gmail-phase') === 'translated');
    const callsAfterTranslate = counted.calls();

    shadowButton(host!, 'Show original').click();
    expect(host?.getAttribute('data-sakutto-gmail-phase')).toBe('original');
    expect(element.textContent).toBe(original);

    const shadow = gmailBannerShadow(host);
    if (!shadow) throw new Error('missing shadow');
    shadow.querySelector<HTMLButtonElement>('.gear')?.click();
    const translateNow = shadow.querySelector<HTMLButtonElement>('[role="menuitem"]');
    if (!translateNow) throw new Error('missing translate menu item');
    expect(translateNow.querySelectorAll('span')).toHaveLength(2);
    translateNow.click();

    expect(host?.getAttribute('data-sakutto-gmail-phase')).toBe('translated');
    expect(element.textContent).toContain('§Hi team, the release is ready for review');
    expect(counted.calls()).toBe(callsAfterTranslate);
    controller.dispose();
  });

  it('auto-translates a remembered source language without offering first', async () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const counted = countingImmediate();
    const controller = new GmailBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: { ...PREFERENCES, autoLanguages: ['en'] },
    });
    controller.start();
    const host = element.previousElementSibling;
    await waitFor(() => host?.getAttribute('data-sakutto-gmail-phase') === 'translated');
    expect(element.textContent).toContain('§Hi team, the release is ready for review');
    expect(counted.calls()).toBeGreaterThan(0);

    controller.refresh();
    controller.refresh();
    expect(counted.calls()).toBeGreaterThan(0);
    const calls = counted.calls();
    controller.refresh();
    expect(counted.calls()).toBe(calls);
    expect(host?.getAttribute('data-sakutto-gmail-phase')).toBe('translated');
    controller.dispose();
  });

  it('keeps one banner host per message when duplicate shells share the same message id', () => {
    document.body.innerHTML = `
      <div data-message-id="m1">
        <sakutto-gmail data-sakutto-gmail-banner="m1"></sakutto-gmail>
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `;
    const orphan = document.querySelector('sakutto-gmail');
    if (orphan?.nextElementSibling) {
      orphan.parentElement?.insertBefore(orphan, orphan.nextElementSibling);
    }
    const spare = document.createElement('sakutto-gmail');
    spare.dataset.sakuttoGmailBanner = 'm1';
    document.querySelector('[data-message-id]')?.appendChild(spare);

    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    expect(document.querySelectorAll(GMAIL_BANNER_TAG)).toHaveLength(1);
    controller.dispose();
  });

  it('does not start a second controller when another bundle already registered one', () => {
    body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const first = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    const second = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    first.start();
    second.start();
    second.refresh();
    expect(document.querySelectorAll(GMAIL_BANNER_TAG)).toHaveLength(1);
    first.dispose();
    second.dispose();
  });

  it('removes a mail banner host stamped by a previous extension build on start', () => {
    document.body.innerHTML = `
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `;
    const row = document.querySelector('[data-message-id]');
    const body = document.querySelector('.a3s');
    if (!row || !body) throw new Error('missing fixture');
    const orphan = document.createElement('sakutto-gmail');
    orphan.dataset.sakuttoExtensionInstance = 'orphan-instance-token';
    row.insertBefore(orphan, body);

    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const hosts = [...document.querySelectorAll(GMAIL_BANNER_TAG)];
    expect(hosts).toHaveLength(1);
    expect((hosts[0] as HTMLElement | undefined)?.dataset.sakuttoExtensionInstance).not.toBe(
      'orphan-instance-token',
    );
    controller.dispose();
  });

  it('keeps a single banner host when Gmail briefly exposes two body nodes for one message', () => {
    document.body.innerHTML = `
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en" id="body-old">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `;
    const old = document.getElementById('body-old');
    if (!old?.parentElement) throw new Error('missing body');
    const next = old.cloneNode(true) as HTMLElement;
    next.id = 'body-new';
    old.parentElement.appendChild(next);
    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    expect(document.querySelectorAll(GMAIL_BANNER_TAG)).toHaveLength(1);
    old.remove();
    controller.refresh();
    expect(document.querySelectorAll(GMAIL_BANNER_TAG)).toHaveLength(1);
    expect(next.previousElementSibling?.localName).toBe(GMAIL_BANNER_TAG);
    controller.dispose();
  });

  it('does not accumulate hosts when refresh runs after Gmail shuffles siblings', () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    const shadow = gmailBannerShadow(host);
    const text = shadow?.querySelector('.text')?.textContent ?? '';
    const parent = element.parentElement;
    if (!parent || !shadow) throw new Error('missing banner');
    for (let index = 0; index < 8; index += 1) {
      parent.insertBefore(document.createElement('div'), element);
      controller.refresh();
    }
    expect(document.querySelectorAll(GMAIL_BANNER_TAG)).toHaveLength(1);
    expect(element.previousElementSibling).toBe(host);
    expect(gmailBannerShadow(host)?.querySelector('.text')?.textContent).toBe(text);
    controller.dispose();
  });

  it('mounts one banner when two content-script instances initialize the same frame', () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const first = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    const second = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    try {
      first.start();
      second.start();
      expect(document.querySelectorAll(GMAIL_BANNER_TAG)).toHaveLength(1);

      // A manual refresh from the duplicate must not mount or prune another host.
      second.refresh();
      const host = element.previousElementSibling;
      expect(document.querySelectorAll(GMAIL_BANNER_TAG)).toHaveLength(1);
      expect(host?.localName).toBe(GMAIL_BANNER_TAG);
      expect(gmailBannerShadow(host)?.querySelector('.text')?.textContent).toBe(
        'This email appears to be written in en.',
      );

      first.dispose();
      expect(document.querySelectorAll(GMAIL_BANNER_TAG)).toHaveLength(0);
      second.start();
      expect(document.querySelectorAll(GMAIL_BANNER_TAG)).toHaveLength(1);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('ignores its own host insertions but still refreshes for page changes', async () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
      debounceMs: 1,
    });
    const refresh = vi.spyOn(controller, 'refresh');
    controller.start();
    expect(refresh).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).toHaveBeenCalledTimes(1);
    const host = element.previousElementSibling;
    const text = gmailBannerShadow(host)?.querySelector('.text')?.textContent;

    document.body.append(document.createElement('div'));
    await waitFor(() => refresh.mock.calls.length > 1);
    expect(document.querySelectorAll(GMAIL_BANNER_TAG)).toHaveLength(1);
    expect(element.previousElementSibling).toBe(host);
    expect(gmailBannerShadow(host)?.querySelector('.text')?.textContent).toBe(text);
    controller.dispose();
  });

  it('dedupes auto-translate by message id when Gmail replaces the body node', async () => {
    document.body.innerHTML = `
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `;
    const first = document.querySelector<HTMLElement>('div.a3s');
    if (!first) throw new Error('missing body');
    const counted = countingImmediate();
    const controller = new GmailBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: { ...PREFERENCES, autoLanguages: ['en'] },
    });
    controller.start();
    await waitFor(
      () => first.previousElementSibling?.getAttribute('data-sakutto-gmail-phase') === 'translated',
    );
    const calls = counted.calls();

    document.body.innerHTML = `
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `;
    controller.refresh();
    expect(counted.calls()).toBe(calls);
    const replacement = document.querySelector('sakutto-gmail');
    expect(replacement).not.toBeNull();
    expect(replacement?.getAttribute('data-sakutto-gmail-phase')).toBe('translated');
    controller.dispose();
  });

  it('skips a message whose source language is on the never list', () => {
    body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    let calls = 0;
    const engine: PageEngine = {
      async *translate(segments) {
        calls += segments.length;
        for (const segment of segments) {
          yield { id: segment.id, final: segment.text, engine: 'plamo' };
        }
      },
    };
    const controller = new GmailBannerController(document, {
      engine,
      labels,
      preferences: { ...PREFERENCES, neverLanguages: ['en'] },
    });
    controller.start();
    expect(document.querySelector(GMAIL_BANNER_TAG)).toBeNull();
    controller.refresh();
    expect(document.querySelector(GMAIL_BANNER_TAG)).toBeNull();
    expect(calls).toBe(0);
    controller.dispose();
  });

  it('opens the gear menu with aria-expanded and closes it with Escape', () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    const shadow = gmailBannerShadow(host);
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

  it('persists always/never choices from the menu with checkmarks', () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const changes: { auto: string[]; never: string[] }[] = [];
    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
      onLanguagesChange: (next) => changes.push(next),
    });
    controller.start();
    const host = element.previousElementSibling;
    const shadow = gmailBannerShadow(host);
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
    expect(document.querySelector(GMAIL_BANNER_TAG)).toBeNull();
    controller.dispose();
  });

  it('does not mount or translate anything when the global switch is off', () => {
    body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const counted = countingImmediate();
    const controller = new GmailBannerController(document, {
      engine: counted.engine,
      labels,
      preferences: { ...PREFERENCES, enabled: false, autoLanguages: ['en'] },
    });
    controller.start();
    expect(document.querySelector(GMAIL_BANNER_TAG)).toBeNull();
    expect(counted.calls()).toBe(0);
    controller.dispose();
  });

  it('removes an open banner when the global switch is turned off', async () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const original = element.textContent;
    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    shadowButton(host!, 'Translate to ja').click();
    await waitFor(() => host?.getAttribute('data-sakutto-gmail-phase') === 'translated');
    controller.setPreferences({ ...PREFERENCES, enabled: false });
    expect(document.querySelector(GMAIL_BANNER_TAG)).toBeNull();
    expect(element.textContent).toBe(original);
  });

  it('keeps language toggles mutually exclusive in the pure helpers', () => {
    const auto = toggleGmailAutoTranslateLanguage('en', { auto: [], never: ['en'] });
    expect(auto).toEqual({ auto: ['en'], never: [] });
    const never = toggleGmailNeverTranslateLanguage('en', auto);
    expect(never).toEqual({ auto: [], never: ['en'] });
  });

  it('shows one banner per expanded message and skips same-language bodies', () => {
    document.body.innerHTML = `
      <div data-message-id="m1">
        <div class="a3s aiL" lang="en">Hi team, the release is ready for review this week.</div>
      </div>
      <div data-message-id="m2">
        <div class="a3s aiL" lang="ja">これは日本語のメールなので、バナーは出ません。</div>
      </div>
      <div data-message-id="m3">
        <div class="a3s aiL" lang="en">Please review the proposal before Friday morning.</div>
      </div>
    `;
    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    expect(document.querySelectorAll(GMAIL_BANNER_TAG)).toHaveLength(2);
    controller.dispose();
  });

  it('hides the banner for that message after close', () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    shadowButton(host!, 'Close').click();
    expect(document.querySelector(GMAIL_BANNER_TAG)).toBeNull();
    controller.refresh();
    expect(document.querySelector(GMAIL_BANNER_TAG)).toBeNull();
    controller.dispose();
  });

  it('restores the original body when dismissed after translating', async () => {
    const element = body(`
      <div data-message-id="m1">
        <div class="a3s aiL">Hi team, the release is ready for review and we should ship it.</div>
      </div>
    `);
    const original = element.textContent;
    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
    });
    controller.start();
    const host = element.previousElementSibling;
    shadowButton(host!, 'Translate to ja').click();
    await waitFor(() => host?.getAttribute('data-sakutto-gmail-phase') === 'translated');
    expect(element.textContent).toContain('§Hi team, the release is ready for review');

    shadowButton(host!, 'Close').click();
    expect(document.querySelector(GMAIL_BANNER_TAG)).toBeNull();
    expect(element.textContent).toBe(original);
    controller.dispose();
  });

  it('adds a banner when Gmail expands a message later', async () => {
    document.body.innerHTML = '<div id="thread"></div>';
    const controller = new GmailBannerController(document, {
      engine: immediate(),
      labels,
      preferences: PREFERENCES,
      debounceMs: 1,
    });
    controller.start();
    const thread = document.querySelector('#thread');
    if (!thread) throw new Error('missing thread');
    thread.innerHTML = `
      <div data-message-id="late">
        <div class="a3s aiL" lang="en">A message loaded after the first scan of the thread.</div>
      </div>
    `;
    await waitFor(() => document.querySelector(GMAIL_BANNER_TAG) !== null);
    controller.dispose();
  });
  it('keeps controls working when the page swallows document-level pointer events', async () => {
    const stopSwallowing = swallowDocumentPresses();
    try {
      const element = body(`
        <div data-message-id="m1">
          <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it this week.</div>
        </div>
      `);
      const original = element.textContent;
      const controller = new GmailBannerController(document, {
        engine: immediate(),
        labels,
        preferences: PREFERENCES,
      });
      controller.start();
      const host = element.previousElementSibling;
      if (!host) throw new Error('missing banner');

      pressSequence(shadowButton(host, 'Translate to ja'));
      await waitFor(() => host.getAttribute('data-sakutto-gmail-phase') === 'translated');
      expect(element.textContent).toContain('§Hi team, the release is ready for review');

      pressSequence(shadowButton(host, 'Show original'));
      expect(host.getAttribute('data-sakutto-gmail-phase')).toBe('original');
      expect(element.textContent).toBe(original);

      pressSequence(shadowButton(host, 'Show translation'));
      expect(host.getAttribute('data-sakutto-gmail-phase')).toBe('translated');
      expect(element.textContent).toContain('§Hi team, the release is ready for review');

      pressSequence(shadowButton(host, 'Close'));
      expect(document.querySelector(GMAIL_BANNER_TAG)).toBeNull();
      expect(element.textContent).toBe(original);
      controller.dispose();
    } finally {
      stopSwallowing();
    }
  });

  it('runs every gear-menu item when the page swallows document-level pointer events', async () => {
    const stopSwallowing = swallowDocumentPresses();
    try {
      const element = body(`
        <div data-message-id="m1">
          <div class="a3s aiL" lang="en">Hi team, the release is ready for review and we should ship it this week.</div>
        </div>
      `);
      const changes: { auto: string[]; never: string[] }[] = [];
      const controller = new GmailBannerController(document, {
        engine: immediate(),
        labels,
        preferences: PREFERENCES,
        onLanguagesChange: (next) => changes.push(next),
      });
      controller.start();
      const host = element.previousElementSibling;
      const shadow = gmailBannerShadow(host);
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
      await waitFor(() => host.getAttribute('data-sakutto-gmail-phase') === 'translated');
      expect(menu.hidden).toBe(true);

      pressSequence(gear);
      pressSequence(auto);
      expect(changes.at(-1)).toEqual({ auto: ['en'], never: [] });
      expect(menu.hidden).toBe(true);

      pressSequence(gear);
      pressSequence(never);
      expect(changes.at(-1)).toEqual({ auto: [], never: ['en'] });
      expect(document.querySelector(GMAIL_BANNER_TAG)).toBeNull();
      controller.dispose();
    } finally {
      stopSwallowing();
    }
  });
});

describe('Gmail body translation', () => {
  it('leaves a body in the target language alone', async () => {
    const element = body(`
      <div class="a3s aiL">
        <div>これは日本語のメールなので翻訳する必要はありません。</div>
      </div>
    `);
    const before = element.innerHTML;
    const applied = await translateGmailBody(element, immediate(), {
      targetLanguage: 'ja',
      form: 'polite',
      language: 'ja',
      signal: new AbortController().signal,
    });
    expect(applied).toHaveLength(0);
    expect(element.innerHTML).toBe(before);
  });
});
