import { describe, expect, it } from 'vitest';
import { agreementFromStorage, hasLicenseConsent } from '@/shared/agreement';
import {
  normalizeSettings,
  PLAMO_LICENSE_VERSION,
  SETTINGS_SCHEMA_VERSION,
} from '@/shared/settings';

describe('stored agreement', () => {
  it('keeps an in-flight start ahead of stored consent', () => {
    expect(agreementFromStorage(false, { started: false })).toBe(false);
    expect(agreementFromStorage(true, { started: false })).toBe(true);
    expect(agreementFromStorage(false, { started: true })).toBeNull();
    expect(agreementFromStorage(true, { started: true })).toBeNull();
  });
});

describe('consent gate', () => {
  const acceptedAt = '2026-11-05T00:00:00.000Z';

  function settingsWith(consent: unknown) {
    return normalizeSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION, consent }, 'ja');
  }

  it('blocks the model download until a consent record exists', () => {
    expect(hasLicenseConsent(null)).toBe(false);
    expect(hasLicenseConsent(undefined)).toBe(false);
    expect(hasLicenseConsent(settingsWith(null))).toBe(false);
    expect(hasLicenseConsent(settingsWith(undefined))).toBe(false);
  });

  it('allows the download for a consent that names the bundled license text', () => {
    expect(
      hasLicenseConsent(
        settingsWith({
          license: 'plamo-community',
          version: PLAMO_LICENSE_VERSION,
          acceptedAt,
          ageNoticeShown: true,
        }),
      ),
    ).toBe(true);
  });

  it('blocks the download for consent written against a different license text', () => {
    expect(
      hasLicenseConsent(
        settingsWith({ license: 'plamo-community', acceptedAt, ageNoticeShown: true }),
      ),
    ).toBe(false);
    expect(
      hasLicenseConsent(
        settingsWith({
          license: 'other',
          version: PLAMO_LICENSE_VERSION,
          acceptedAt,
          ageNoticeShown: true,
        }),
      ),
    ).toBe(false);
    expect(
      hasLicenseConsent(
        settingsWith({
          license: 'plamo-community',
          version: PLAMO_LICENSE_VERSION,
          acceptedAt: 'not-a-date',
          ageNoticeShown: true,
        }),
      ),
    ).toBe(false);
  });
});
