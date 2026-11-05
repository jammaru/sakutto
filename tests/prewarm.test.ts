import { describe, expect, it } from 'vitest';
import { prewarmRequest } from '@/engine/cache/prewarm';

describe('frequent UI strings', () => {
  it('prepares English labels for a Japanese target and skips Chrome-only languages', () => {
    const japanese = prewarmRequest('ja-JP');
    expect(japanese?.src).toBe('en');
    expect(japanese?.segments.map((segment) => segment.text)).toContain('Sign in');

    expect(prewarmRequest('en')?.src).toBe('ja');
    expect(prewarmRequest('pt')).toBeNull();
    expect(prewarmRequest('nope')).toBeNull();
  });
});
