import type { TranslateOptions, TranslateSegment, TranslationChunk } from '@/engine/types';

const PLACEHOLDER = /(<\/?i\d+>)/;

/** Keeps the source words so a fixture can see that the sentence itself was not rewritten. */
export function fakeMarker(targetLanguage: string): string {
  return `§${targetLanguage}§`;
}

export function fakeTranslateText(text: string, targetLanguage: string): string {
  const marker = fakeMarker(targetLanguage);
  return text
    .split(PLACEHOLDER)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      if (part.length === 0) return '';
      return `${marker}${part}`;
    })
    .join('');
}

export async function* fakeTranslate(
  segments: readonly TranslateSegment[],
  options: TranslateOptions,
): AsyncGenerator<TranslationChunk> {
  for (const segment of segments) {
    if (options.signal.aborted) return;
    const text = fakeTranslateText(segment.text, options.tgt);
    yield { id: segment.id, final: text, engine: 'plamo' };
  }
}
