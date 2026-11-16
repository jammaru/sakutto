import { GMAIL_ADAPTER } from './mail-banner-adapters';
import {
  MailBannerController,
  translateMailBody,
  type AppliedBlock,
  type MailBannerLabels,
  type MailBannerOptions,
  type MailBannerPreferences,
  type MailBodyTranslationOptions,
} from './mail-banner-core';

export {
  GMAIL_BANNER_TAG,
  GMAIL_MIN_BODY_CHARS,
  detectGmailMessageLanguage,
  findGmailMessageBodies,
  gmailMessageKey,
  isGmailHost,
  isGmailMessageBody,
  shouldAutoInjectGmailBanner,
  shouldOfferGmailTranslation,
} from './mail-banner-adapters';

export {
  initialMailBannerState as initialGmailBannerState,
  mailBannerAfterDismiss as gmailBannerAfterDismiss,
  mailBannerAfterShowOriginal as gmailBannerAfterShowOriginal,
  mailBannerAfterShowTranslation as gmailBannerAfterShowTranslation,
  mailBannerAfterTranslate as gmailBannerAfterTranslate,
  mailBannerAfterTranslated as gmailBannerAfterTranslated,
  mailBannerButton as gmailBannerButton,
  mailBannerShadow as gmailBannerShadow,
  type MailBannerButton as GmailBannerButton,
  type MailBannerGate as GmailBannerGate,
  type MailBannerPhase as GmailBannerPhase,
  type MailBannerState as GmailBannerState,
} from './mail-banner-core';

export {
  gmailTranslateLanguagePreference,
  isGmailAutoTranslateLanguage,
  isGmailNeverTranslateLanguage,
  normalizeGmailLanguageList,
  normalizeGmailTranslateLanguages,
  removeGmailTranslateLanguage,
  toggleGmailAutoTranslateLanguage,
  toggleGmailNeverTranslateLanguage,
  type GmailTranslateLanguages,
} from '@/shared/settings';

export type GmailBannerLabels = MailBannerLabels;
export type GmailBannerOptions = MailBannerOptions;
export type GmailBannerPreferences = MailBannerPreferences;
export type GmailBodyTranslationOptions = MailBodyTranslationOptions;

export class GmailBannerController extends MailBannerController {
  constructor(doc: Document, options: GmailBannerOptions) {
    super(doc, GMAIL_ADAPTER, options);
  }
}

/** Translate only the prose under one Gmail message body, keeping formatting in place. */
export function translateGmailBody(
  root: Element,
  engine: Parameters<typeof translateMailBody>[1],
  options: GmailBodyTranslationOptions,
): Promise<AppliedBlock[]> {
  return translateMailBody(root, engine, options, GMAIL_ADAPTER);
}
