import { afterEach, describe, expect, it } from 'vitest';
import { installAdapterNoiseFilter } from '@/shared/capabilities';

describe('adapter noise filter', () => {
  const originalError = console.error;
  const originalWarn = console.warn;

  afterEach(() => {
    console.error = originalError;
    console.warn = originalWarn;
  });

  it('drops the missing-adapter message and keeps other errors', () => {
    const calls: string[] = [];
    const record = (...args: unknown[]): void => {
      calls.push(args.map((value) => String(value)).join(' '));
    };
    console.error = record;
    console.warn = record;
    const restore = installAdapterNoiseFilter();

    console.error('No available adapters.');
    console.warn('No available adapters.');
    console.error('disk full');

    expect(calls).toEqual(['disk full']);
    restore();
  });
});
