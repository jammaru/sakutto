import {
  DEFAULT_MAIL_BANNER_STYLE,
  MAIL_MIN_BODY_CHARS,
  detectMailMessageLanguage,
  shouldOfferMailTranslation,
  type MailBannerAdapter,
  type MailBannerGate,
} from './mail-banner-core';

const COMPOSE_SELECTOR = [
  'textarea',
  'input',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
].join(', ');

export const GMAIL_MIN_BODY_CHARS = MAIL_MIN_BODY_CHARS;
export const OUTLOOK_MIN_BODY_CHARS = MAIL_MIN_BODY_CHARS;

const GMAIL_BODY_SELECTOR = 'div.a3s, .a3s.aiL';

export const GMAIL_BANNER_TAG = 'sakutto-gmail';
export const GMAIL_ACTION_EVENT = 'sakutto-gmail-action';
export const GMAIL_TRANSLATED_ATTRIBUTE = 'data-sakutto-gmail-translated';

export function isGmailHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'mail.google.com' || normalized.endsWith('.mail.google.com');
}

export function shouldAutoInjectGmailBanner(options: {
  settingOn: boolean;
  host: string;
  originAllowed: boolean;
}): boolean {
  return options.settingOn && options.originAllowed && isGmailHost(options.host);
}

export function isGmailMessageBody(element: Element): boolean {
  if (!element.matches(GMAIL_BODY_SELECTOR)) return false;
  if (element.closest(COMPOSE_SELECTOR)) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  return true;
}

export function findGmailMessageBodies(root: ParentNode): Element[] {
  const bodies = new Set<Element>();
  if (root instanceof Element && isGmailMessageBody(root)) bodies.add(root);
  for (const element of root.querySelectorAll(GMAIL_BODY_SELECTOR)) {
    if (isGmailMessageBody(element)) bodies.add(element);
  }
  return [...bodies];
}

export function gmailMessageKey(body: Element): string {
  const row = body.closest('[data-message-id], [data-legacy-message-id]');
  return row?.getAttribute('data-message-id') ?? row?.getAttribute('data-legacy-message-id') ?? '';
}

/**
 * OWA renders a reading-pane body as a `role="document"` region, usually labelled
 * "Message body", inside a conversation node that carries `data-convid` and often an `id`.
 * The list below keeps those stable attributes first and only falls back to OWA's own
 * `UniqueMessageBody` id or the legacy body class, which are less stable but still readable
 * across current Outlook web builds. Minified class hashes are deliberately not used.
 */
const OUTLOOK_BODY_SELECTOR = [
  '[role="document"][aria-label*="Message body"]',
  '[role="document"][aria-label*="message body"]',
  '[role="document"][aria-label*="メッセージ本文"]',
  '[role="document"][aria-label*="メール本文"]',
  '[aria-label*="Message body"] [role="document"]',
  '[data-app-section="MessageBody"] [role="document"]',
  '[id^="UniqueMessageBody"]',
  '.uniqueMessageBody',
].join(', ');

export const OUTLOOK_BANNER_TAG = 'sakutto-outlook';
export const OUTLOOK_ACTION_EVENT = 'sakutto-outlook-action';
export const OUTLOOK_TRANSLATED_ATTRIBUTE = 'data-sakutto-outlook-translated';

const OUTLOOK_HOSTS = [
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'outlook.cloud.microsoft',
] as const;

export function isOutlookHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return OUTLOOK_HOSTS.some(
    (candidate) => normalized === candidate || normalized.endsWith(`.${candidate}`),
  );
}

export function shouldAutoInjectOutlookBanner(options: {
  settingOn: boolean;
  host: string;
  originAllowed: boolean;
}): boolean {
  return options.settingOn && options.originAllowed && isOutlookHost(options.host);
}

export function isOutlookMessageBody(element: Element): boolean {
  if (!element.matches(OUTLOOK_BODY_SELECTOR)) return false;
  if (element.closest(COMPOSE_SELECTOR)) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  return true;
}

export function findOutlookMessageBodies(root: ParentNode): Element[] {
  const bodies = new Set<Element>();
  if (root instanceof Element && isOutlookMessageBody(root)) bodies.add(root);
  for (const element of root.querySelectorAll(OUTLOOK_BODY_SELECTOR)) {
    if (isOutlookMessageBody(element)) bodies.add(element);
  }
  // Some OWA builds mark both the reading-pane wrapper and the document inside it. Keep
  // the innermost node so one message never gets two banners.
  for (const candidate of [...bodies]) {
    for (const other of bodies) {
      if (candidate !== other && candidate.contains(other)) {
        bodies.delete(candidate);
        break;
      }
    }
  }
  return [...bodies];
}

export function outlookMessageKey(body: Element): string {
  const row = body.closest('[data-message-id], [data-item-id]');
  const explicit = row?.getAttribute('data-message-id') ?? row?.getAttribute('data-item-id');
  if (explicit) return explicit;

  // A conversation id is shared by every expanded message, so include the message node's
  // own id when OWA provides one. Without either attribute the banner simply has no key.
  const message = body.closest('[data-convid]');
  const conversation = message?.getAttribute('data-convid') ?? '';
  const messageId = message?.id || body.id;
  if (conversation && messageId) return `${conversation}:${messageId}`;
  return messageId || conversation;
}

export function detectGmailMessageLanguage(body: Element, targetLanguage: string): string | null {
  return detectMailMessageLanguage(body, targetLanguage);
}

export function detectOutlookMessageLanguage(body: Element, targetLanguage: string): string | null {
  return detectMailMessageLanguage(body, targetLanguage);
}

export function shouldOfferGmailTranslation(input: MailBannerGate): boolean {
  return shouldOfferMailTranslation(input);
}

export function shouldOfferOutlookTranslation(input: MailBannerGate): boolean {
  return shouldOfferMailTranslation(input);
}

export const GMAIL_ADAPTER: MailBannerAdapter = {
  id: 'gmail',
  tag: GMAIL_BANNER_TAG,
  actionEvent: GMAIL_ACTION_EVENT,
  bannerDataset: 'sakuttoGmailBanner',
  phaseDataset: 'sakuttoGmailPhase',
  languageDataset: 'sakuttoGmailLanguage',
  translatedAttribute: GMAIL_TRANSLATED_ATTRIBUTE,
  style: DEFAULT_MAIL_BANNER_STYLE,
  findMessageBodies: findGmailMessageBodies,
  messageKey: gmailMessageKey,
  detectLanguage: detectGmailMessageLanguage,
  shouldOffer: shouldOfferGmailTranslation,
};

const OUTLOOK_BANNER_STYLE = `
:host {
  all: initial;
}
.banner {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin: 0 0 6px;
  padding: 7px 10px;
  border: 1px solid #e1dfdd;
  border-radius: 4px;
  background: #faf9f8;
  color: #242424;
  font: 13px/1.4 "Segoe UI", "Segoe UI Web (West European)", "Hiragino Sans", "Noto Sans JP",
    sans-serif;
  box-shadow: 0 1px 2px rgb(0 0 0 / 6%);
}
.banner.compact {
  gap: 8px;
  padding: 6px 9px;
  background: #f3f2f1;
  font-size: 12.5px;
}
.icon {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  color: #0f6cbd;
}
.text {
  flex: 1 1 auto;
  min-width: 0;
}
button {
  font: inherit;
}
.action {
  flex: 0 0 auto;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #0f6cbd;
  cursor: pointer;
  font-weight: 600;
  padding: 3px 6px;
  white-space: nowrap;
}
.action:hover {
  background: rgb(15 108 189 / 8%);
  text-decoration: underline;
}
.action:disabled {
  color: #616161;
  cursor: default;
  text-decoration: none;
}
.close,
.gear {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #616161;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
}
.close:hover,
.gear:hover,
.gear[aria-expanded="true"] {
  background: rgb(0 0 0 / 6%);
}
.gear {
  display: inline-grid;
  place-items: center;
}
.gear svg {
  width: 17px;
  height: 17px;
}
.menu-wrap {
  position: relative;
  flex: 0 0 auto;
}
.menu {
  position: absolute;
  z-index: 2147483647;
  top: calc(100% + 6px);
  right: 0;
  box-sizing: border-box;
  min-width: 220px;
  padding: 6px;
  border: 1px solid #e1dfdd;
  border-radius: 6px;
  background: #ffffff;
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
}
.menu[hidden] {
  display: none;
}
.menu-item {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: 18px 1fr;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #242424;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}
.menu-item:hover,
.menu-item:focus-visible {
  background: rgb(15 108 189 / 9%);
  outline: none;
}
.check {
  color: #0f6cbd;
  font-weight: 700;
  text-align: center;
}
.action:focus-visible,
.close:focus-visible,
.gear:focus-visible,
.menu-item:focus-visible {
  outline: 2px solid #0f6cbd;
  outline-offset: 1px;
}
@media (prefers-color-scheme: dark) {
  .banner {
    border-color: #3b3a39;
    background: #292827;
    color: #f3f2f1;
  }
  .banner.compact {
    background: #323130;
  }
  .icon {
    color: #479ef5;
  }
  .action {
    color: #479ef5;
  }
  .action:hover {
    background: rgb(71 158 245 / 14%);
  }
  .action:disabled,
  .close,
  .gear {
    color: #a19f9d;
  }
  .close:hover,
  .gear:hover,
  .gear[aria-expanded="true"] {
    background: rgb(243 242 241 / 10%);
  }
  .menu {
    border-color: #3b3a39;
    background: #323130;
    box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
  }
  .menu-item {
    color: #f3f2f1;
  }
  .menu-item:hover,
  .menu-item:focus-visible {
    background: rgb(71 158 245 / 14%);
  }
  .check {
    color: #479ef5;
  }
}
`;

export const OUTLOOK_ADAPTER: MailBannerAdapter = {
  id: 'outlook',
  tag: OUTLOOK_BANNER_TAG,
  actionEvent: OUTLOOK_ACTION_EVENT,
  bannerDataset: 'sakuttoOutlookBanner',
  phaseDataset: 'sakuttoOutlookPhase',
  languageDataset: 'sakuttoOutlookLanguage',
  translatedAttribute: OUTLOOK_TRANSLATED_ATTRIBUTE,
  style: OUTLOOK_BANNER_STYLE,
  findMessageBodies: findOutlookMessageBodies,
  messageKey: outlookMessageKey,
  detectLanguage: detectOutlookMessageLanguage,
  shouldOffer: shouldOfferOutlookTranslation,
};
