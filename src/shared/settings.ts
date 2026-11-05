import type { GlossaryEntry } from '@/engine/types';
import { normalizeGlossary } from './glossary';
import {
  DEFAULT_TARGET_LANGUAGE,
  isTargetLanguage,
  resolveTargetLanguage,
  type TargetLanguage,
} from './languages';
import { isRecord } from './object';

export const SETTINGS_SCHEMA_VERSION = 1;

/** Date the bundled PLaMo Community License text was copied into this repository. */
export const PLAMO_LICENSE_VERSION = '2026-11-05';

export type Formality = 'polite' | 'plain';
export type DisplayMode = 'replace' | 'bilingual';
export type TierPreference = 'auto' | 'g' | 'c8' | 'c4';
export type TranslationPace = 'fast' | 'quality';
export type IdleMinutes = 0 | 1 | 5 | 15;

export interface LicenseConsent {
  license: 'plamo-community';
  version: typeof PLAMO_LICENSE_VERSION;
  acceptedAt: string;
  guardian: true;
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
  >
>;

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
});

export function createDefaultSettings(uiLanguage: string): Settings {
  return {
    ...DEFAULT_SETTINGS,
    glossary: [],
    targetLanguage: resolveTargetLanguage(uiLanguage),
  };
}

export function isTranslationPace(value: unknown): value is TranslationPace {
  return value === 'fast' || value === 'quality';
}

export function isTierPreference(value: unknown): value is TierPreference {
  return value === 'auto' || value === 'g' || value === 'c8' || value === 'c4';
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
  };
}

function normalizeConsent(value: unknown): LicenseConsent | null {
  if (!isRecord(value)) return null;
  if (value.license !== 'plamo-community') return null;
  if (value.version !== PLAMO_LICENSE_VERSION) return null;
  if (value.guardian !== true) return null;
  if (typeof value.acceptedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value.acceptedAt)) {
    return null;
  }
  return {
    license: 'plamo-community',
    version: PLAMO_LICENSE_VERSION,
    acceptedAt: value.acceptedAt,
    guardian: true,
  };
}
