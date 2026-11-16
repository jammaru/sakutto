import { OUTLOOK_ADAPTER } from './mail-banner-adapters';
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
  OUTLOOK_ACTION_EVENT,
  OUTLOOK_BANNER_TAG,
  OUTLOOK_MIN_BODY_CHARS,
  OUTLOOK_TRANSLATED_ATTRIBUTE,
  detectOutlookMessageLanguage,
  findOutlookMessageBodies,
  isOutlookHost,
  isOutlookMessageBody,
  outlookMessageKey,
  shouldAutoInjectOutlookBanner,
  shouldOfferOutlookTranslation,
} from './mail-banner-adapters';

export {
  initialMailBannerState as initialOutlookBannerState,
  mailBannerAfterDismiss as outlookBannerAfterDismiss,
  mailBannerAfterShowOriginal as outlookBannerAfterShowOriginal,
  mailBannerAfterShowTranslation as outlookBannerAfterShowTranslation,
  mailBannerAfterTranslate as outlookBannerAfterTranslate,
  mailBannerAfterTranslated as outlookBannerAfterTranslated,
  mailBannerButton as outlookBannerButton,
  mailBannerShadow as outlookBannerShadow,
  type MailBannerButton as OutlookBannerButton,
  type MailBannerGate as OutlookBannerGate,
  type MailBannerPhase as OutlookBannerPhase,
  type MailBannerState as OutlookBannerState,
} from './mail-banner-core';

export type OutlookBannerLabels = MailBannerLabels;
export type OutlookBannerOptions = MailBannerOptions;
export type OutlookBannerPreferences = MailBannerPreferences;
export type OutlookBodyTranslationOptions = MailBodyTranslationOptions;

export class OutlookBannerController extends MailBannerController {
  constructor(doc: Document, options: OutlookBannerOptions) {
    super(doc, OUTLOOK_ADAPTER, options);
  }
}

/** Translate only the prose under one Outlook reading-pane body, keeping formatting in place. */
export function translateOutlookBody(
  root: Element,
  engine: Parameters<typeof translateMailBody>[1],
  options: OutlookBodyTranslationOptions,
): Promise<AppliedBlock[]> {
  return translateMailBody(root, engine, options, OUTLOOK_ADAPTER);
}
