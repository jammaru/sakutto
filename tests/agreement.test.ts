import { describe, expect, it } from 'vitest';
import { agreementFromStorage } from '@/shared/agreement';

describe('stored agreement', () => {
  it('keeps an in-flight start ahead of stored consent', () => {
    expect(agreementFromStorage(false, { started: false })).toBe(false);
    expect(agreementFromStorage(true, { started: false })).toBe(true);
    expect(agreementFromStorage(false, { started: true })).toBeNull();
    expect(agreementFromStorage(true, { started: true })).toBeNull();
  });
});
