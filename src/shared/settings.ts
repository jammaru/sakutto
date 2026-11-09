import type { GlossaryEntry } from '@/engine/types';
import { normalizeGlossary } from './glossary';
import {
  DEFAULT_TARGET_LANGUAGE,
  isChromeOnlyLanguage,
  isTargetLanguage,
  resolveTargetLanguage,
  type TargetLanguage,
} from './languages';
import { isRecord } from './object';
import {
  defaultShortcutEnabled,
  normalizeShortcutEnabled,
  type ShortcutEnabled,
} from './shortcuts';

export const SETTINGS_SCHEMA_VERSION = 1;

/** Date the bundled PLaMo Community License text was copied into this repository. */
export const PLAMO_LICENSE_VERSION = '2026-11-05';

/**
 * Version of the consent notice — the explanation shown beside the agree button — not of
 * the license text itself.
 *
 * It is stored in the same record as the license version because the two answer different
 * questions. `PLAMO_LICENSE_VERSION` says which legal text the user agreed to.
 * `PLAMO_NOTICE_VERSION` says which explanation of the terms they read before agreeing. A
 * user who agreed to the older, denser commercial summary has technically accepted the same
 * license, but they have not seen the clearer three-part one, so the record has to be able to
 * say "this agreement predates the clearer notice" without invalidating the license itself.
 */
export const PLAMO_NOTICE_VERSION = '2026-11-06';

export type Formality = 'polite' | 'plain';
export type DisplayMode = 'replace' | 'bilingual';
export type TierPreference = 'auto' | 'g' | 'c8' | 'c4' | 'c1';
export type TranslationPace = 'fast' | 'quality';
export type IdleMinutes = 0 | 1 | 5 | 15;
export const COMPOSE_PLACEMENTS = ['above', 'below', 'corner', 'free'] as const;
export type ComposePlacement = (typeof COMPOSE_PLACEMENTS)[number];
export type ComposeFreePoint = { x: number; y: number };

export interface LicenseConsent {
  license: 'plamo-community';
  version: typeof PLAMO_LICENSE_VERSION;
  /**
   * Which onboarding notice was on screen when the button was pressed. `legacy` for a record
   * written before this field existed; see `LEGACY_NOTICE_VERSION`.
   */
  notice: string;
  acceptedAt: string;
  /**
   * True when the onboarding click happened with the age notice on screen. It records that
   * the notice was shown, not that a guardian was asked or that the user's age was checked.
   */
  ageNoticeShown: true;
}

export interface Settings {
  schemaVersion: number;
  targetLanguage: TargetLanguage;
  form: Formality;
  display: DisplayMode;
  consent: LicenseConsent | null;
  highQualityDismissed: boolean;
  glossary: GlossaryEntry[];
  idleMinutes: IdleMinutes;
  tier: TierPreference;
  pace: TranslationPace;
  /** False hides the あA button on message boxes. The shortcut and context menu stay. */
  composeIcon: boolean;
  /**
   * Per-command on/off in Sakutto. Unchecking disables the in-page key. Clearing the
   * binding in the browser's shortcut editor also stops in-page handling, unless the
   * browser never assigned the suggested key (a conflict at install).
   */
  shortcutsEnabled: ShortcutEnabled;
  /**
   * When set, compose translation always uses this target. `null` keeps the heuristic:
   * Japanese drafts go to the other side of the pair, everything else to the page target.
   */
  composeTargetLanguage: TargetLanguage | null;
  /** One shortcut press translates and replaces, skipping the preview confirmation. */
  composeInstantReplace: boolean;
  /** Where the compose preview bar sits. Sites may override this from the bar menu. */
  composePlacement: ComposePlacement;
}

export type SettingsPatch = Partial<
  Pick<
    Settings,
    | 'targetLanguage'
    | 'form'
    | 'display'
    | 'consent'
    | 'highQualityDismissed'
    | 'glossary'
    | 'idleMinutes'
    | 'tier'
    | 'pace'
    | 'composeIcon'
    | 'composeTargetLanguage'
    | 'composeInstantReplace'
    | 'composePlacement'
  >
> & {
  shortcutsEnabled?: Partial<ShortcutEnabled>;
};

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
  form: 'polite',
  display: 'replace',
  consent: null,
  highQualityDismissed: false,
  glossary: [],
  idleMinutes: 5,
  tier: 'auto',
  pace: 'quality',
  composeIcon: true,
  shortcutsEnabled: defaultShortcutEnabled(),
  composeTargetLanguage: null,
  composeInstantReplace: false,
  composePlacement: 'above',
});

export function createDefaultSettings(uiLanguage: string): Settings {
  return {
    ...DEFAULT_SETTINGS,
    glossary: [],
    shortcutsEnabled: defaultShortcutEnabled(),
    targetLanguage: resolveTargetLanguage(uiLanguage),
  };
}

export function isTranslationPace(value: unknown): value is TranslationPace {
  return value === 'fast' || value === 'quality';
}

export function isTierPreference(value: unknown): value is TierPreference {
  return value === 'auto' || value === 'g' || value === 'c8' || value === 'c4' || value === 'c1';
}

export function isIdleMinutes(value: unknown): value is IdleMinutes {
  return value === 0 || value === 1 || value === 5 || value === 15;
}

export function normalizeSettings(value: unknown, uiLanguage: string): Settings {
  const defaults = createDefaultSettings(uiLanguage);
  if (!isRecord(value) || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) return defaults;

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    targetLanguage: isTargetLanguage(value.targetLanguage)
      ? value.targetLanguage
      : defaults.targetLanguage,
    form: value.form === 'plain' ? 'plain' : 'polite',
    display: value.display === 'bilingual' ? 'bilingual' : 'replace',
    consent: normalizeConsent(value.consent),
    highQualityDismissed: value.highQualityDismissed === true,
    glossary: normalizeGlossary(value.glossary),
    idleMinutes: isIdleMinutes(value.idleMinutes) ? value.idleMinutes : defaults.idleMinutes,
    tier: isTierPreference(value.tier) ? value.tier : defaults.tier,
    pace: isTranslationPace(value.pace) ? value.pace : defaults.pace,
    composeIcon: value.composeIcon !== false,
    shortcutsEnabled: normalizeShortcutEnabled(value.shortcutsEnabled),
    composeTargetLanguage: normalizeComposeTarget(value.composeTargetLanguage),
    composeInstantReplace: value.composeInstantReplace === true,
    composePlacement: isComposePlacement(value.composePlacement) ? value.composePlacement : 'above',
  };
}

export function isComposePlacement(value: unknown): value is ComposePlacement {
  return value === 'above' || value === 'below' || value === 'corner' || value === 'free';
}

export function normalizeComposeFreePoint(value: unknown): ComposeFreePoint | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.x !== 'number' || typeof value.y !== 'number') return undefined;
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return undefined;
  return { x: value.x, y: value.y };
}

function normalizeComposeTarget(value: unknown): TargetLanguage | null {
  if (!isTargetLanguage(value) || isChromeOnlyLanguage(value)) return null;
  return value;
}

function isAcceptedAt(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

/**
 * Reads a stored consent record.
 *
 * Three shapes exist in the wild:
 *
 * 1. `licenses/` text plus the current notice — the record this build writes.
 * 2. The same license with an earlier notice, or with no notice field at all. These are
 *    kept, because the license text really was agreed to and dropping the record would send
 *    every existing user back through onboarding. They are marked with the notice version
 *    they were written under, so the UI can show the clearer explanation once.
 * 3. Records written before the age notice was renamed, which stored `guardian: true` from
 *    the same click. They describe the same license text, so they keep counting; the
 *    rewritten record stores only that the notice was shown, never that a guardian agreed.
 */
function normalizeConsent(value: unknown): LicenseConsent | null {
  if (!isRecord(value)) return null;
  if (value.license !== 'plamo-community') return null;
  if (value.version !== PLAMO_LICENSE_VERSION) return null;
  if (value.ageNoticeShown !== true && value.guardian !== true) return null;
  if (!isAcceptedAt(value.acceptedAt)) return null;
  return {
    license: 'plamo-community',
    version: PLAMO_LICENSE_VERSION,
    notice: isNoticeVersion(value.notice) ? value.notice : LEGACY_NOTICE_VERSION,
    acceptedAt: value.acceptedAt,
    ageNoticeShown: true,
  };
}

/**
 * A user who agreed before the clearer commercial summary has a valid license record but has
 * never seen the new explanation. Showing it once more must not throw away the model file, so
 * this asks for the overlay rather than a fresh download.
 */
export function needsLicenseReconsent(settings: { consent: unknown } | null | undefined): boolean {
  const consent = settings === null || settings === undefined ? null : settings.consent;
  if (!isRecord(consent)) return false;
  return !isNoticeVersion(consent.notice);
}

/** A notice version string this build recognises. */
export function isNoticeVersion(value: unknown): value is typeof PLAMO_NOTICE_VERSION {
  return value === PLAMO_NOTICE_VERSION;
}

/**
 * The notice version assigned to a record that predates the field. It is not a real version
 * and never matches `PLAMO_NOTICE_VERSION`, which is what makes `needsLicenseReconsent` true
 * for those records exactly once.
 */
export const LEGACY_NOTICE_VERSION = 'legacy';
