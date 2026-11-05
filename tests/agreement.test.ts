import { describe, expect, it } from 'vitest';
import { agreementFromStorage } from '@/shared/agreement';

describe('stored agreement', () => {
  it('keeps a checkbox change and an in-flight start ahead of stored consent', () => {
    expect(agreementFromStorage(false, { touched: false, started: false })).toBe(false);
    expect(agreementFromStorage(true, { touched: false, started: false })).toBe(true);
    expect(agreementFromStorage(false, { touched: true, started: false })).toBeNull();
    expect(agreementFromStorage(false, { touched: false, started: true })).toBeNull();
  });
});
