import { describe, expect, it } from 'vitest';
import { translationEchoesSource } from '@/pdf/language';

describe('translationEchoesSource', () => {
  it('rejects unchanged English when the target is Japanese', () => {
    const source =
      'Therefore it is essential to evaluate the detector with multiple configurations.';
    expect(translationEchoesSource(source, source, 'ja')).toBe(true);
    expect(
      translationEchoesSource(
        source,
        'したがって、評価器を複数の設定で評価することが不可欠です。',
        'ja',
      ),
    ).toBe(false);
  });

  it('allows intentional same-language for an English target', () => {
    const source = 'The queue grows while the reader scrolls.';
    expect(translationEchoesSource(source, source, 'en')).toBe(true);
    expect(translationEchoesSource(source, 'The queue grows while the reader scrolls.', 'en')).toBe(
      true,
    );
  });
});
