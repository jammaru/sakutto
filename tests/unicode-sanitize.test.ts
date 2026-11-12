// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { CaptionTranslator } from '@/captions/engine';
import { normalizeCaptionText } from '@/captions/cues';
import { applyTranslation, restoreSegment } from '@/dom/render';
import { buildSegment } from '@/dom/segment';
import { CachingEngine } from '@/engine/cache/caching-engine';
import { TranslationCache } from '@/engine/cache/cache';
import { buildTranslationCacheKey } from '@/engine/cache/key';
import { MemoryTranslationCacheStore } from '@/engine/cache/store';
import {
  ChromeTranslatorEngine,
  type TranslatorConstructor,
  type TranslatorInstance,
} from '@/engine/chrome/translator';
import { InBrowserEngine } from '@/engine/in-browser/engine';
import { cleanModelOutput } from '@/engine/prompt/pfml3';
import {
  ISSUE_73_HIDDEN,
  hasTranslatableText,
  isInvisibleRunawayOutput,
  sanitizeTranslationInput,
  stripLoneSurrogates,
  visibleContent,
} from '@/engine/text/sanitize';
import type { PageEngine } from '@/dom/session';
import type { TranslateOptions, TranslateSegment, TranslationChunk } from '@/engine/types';
import { normalizeTypedInput } from '@/shared/typed-translation';
import { collectChunks, FakeRuntime } from './support/fakes';
import { promptSource } from './support/sim-runtime';

function options(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
  return {
    tgt: 'ja',
    form: 'polite',
    priority: 10,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function displayed(chunks: readonly TranslationChunk[]): string {
  return chunks.reduce((text, chunk) => {
    if (chunk.textDelta !== undefined) {
      return chunk.restart === true ? chunk.textDelta : text + chunk.textDelta;
    }
    if (chunk.final !== undefined) return chunk.final;
    return text;
  }, '');
}

const ENGLAND_FLAG = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
const FAMILY = '👨\u200D👩\u200D👧\u200D👦';
const PERSIAN = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';
const HINDI_ZWNJ = '\u0915\u094D\u200C\u0937';
const CJK_IVS = '\u845B\u{E0100}';

const CASES: ReadonlyArray<{ name: string; input: string; expected: string }> = [
  {
    name: 'issue #73 WORD JOINER + ZWNJ + ZWJ in Latin Hello world',
    input: `Hello${ISSUE_73_HIDDEN} world.`,
    expected: 'Hello world.',
  },
  {
    name: 'issue #73 paragraph with a joiner run before the sentence',
    input: `Single\n\n${ISSUE_73_HIDDEN}I have a child from a previous relationship.`,
    expected: 'Single\n\nI have a child from a previous relationship.',
  },
  { name: 'ZWSP U+200B', input: 'Hi\u200B there', expected: 'Hi there' },
  { name: 'BOM / ZWNBSP U+FEFF', input: '\uFEFFHello', expected: 'Hello' },
  { name: 'soft hyphen U+00AD', input: 'hyphen\u00ADation', expected: 'hyphenation' },
  { name: 'invisible times U+2062', input: '2\u20623', expected: '23' },
  { name: 'function application U+2061', input: 'sin\u2061x', expected: 'sinx' },
  { name: 'Mongolian vowel separator U+180E', input: 'a\u180Eb', expected: 'ab' },
  { name: 'NBSP U+00A0', input: 'a\u00A0b', expected: 'a b' },
  { name: 'narrow NBSP U+202F', input: 'a\u202Fb', expected: 'a b' },
  { name: 'ideographic space U+3000', input: '東\u3000京', expected: '東 京' },
  { name: 'line separator U+2028', input: 'a\u2028b', expected: 'a\nb' },
  { name: 'paragraph separator U+2029', input: 'a\u2029b', expected: 'a\nb' },
  { name: 'C0 NUL', input: 'A\u0000B', expected: 'AB' },
  { name: 'C1 U+0085', input: 'A\u0085B', expected: 'AB' },
  { name: 'private-use U+E001', input: 'A\uE001B', expected: 'AB' },
  { name: 'bidi override in Latin', input: 'Hello\u202Eworld', expected: 'Helloworld' },
  { name: 'LRM in Latin', input: 'Hello\u200E world', expected: 'Hello world' },
  {
    name: 'RLM kept next to Arabic',
    input: '\u0633\u0644\u0627\u0645\u200F',
    expected: '\u0633\u0644\u0627\u0645\u200F',
  },
  { name: 'emoji ZWJ family', input: FAMILY, expected: FAMILY },
  { name: 'emoji skin tone', input: '👍\u{1F3FD}', expected: '👍\u{1F3FD}' },
  { name: 'emoji VS16', input: '\u2600\uFE0F', expected: '\u2600\uFE0F' },
  { name: 'keycap', input: '1\uFE0F\u20E3', expected: '1\uFE0F\u20E3' },
  { name: 'England flag tag sequence', input: ENGLAND_FLAG, expected: ENGLAND_FLAG },
  { name: 'lone tag in Latin', input: 'Hi\u{E0020}there', expected: 'Hithere' },
  { name: 'Persian ZWNJ', input: PERSIAN, expected: PERSIAN },
  { name: 'Hindi virama + ZWNJ', input: HINDI_ZWNJ, expected: HINDI_ZWNJ },
  { name: 'ZWJ between Latin letters dropped', input: 'ab\u200Dcd', expected: 'abcd' },
  { name: 'ZWNJ between Latin letters dropped', input: 'ab\u200Ccd', expected: 'abcd' },
  { name: 'NFC Japanese dakuten', input: 'か\u3099', expected: 'が' },
  { name: 'NFC accented Latin', input: 'e\u0301', expected: 'é' },
  { name: 'fullwidth not NFKC', input: 'Ｈｅｌｌｏ', expected: 'Ｈｅｌｌｏ' },
  { name: 'circled digit not NFKC', input: '①', expected: '①' },
  { name: 'halfwidth katakana not NFKC', input: 'ｶﾀｶﾅ', expected: 'ｶﾀｶﾅ' },
  { name: 'CJK IVS kept', input: CJK_IVS, expected: CJK_IVS },
  { name: 'lone VS16 dropped', input: '\uFE0FHello', expected: 'Hello' },
  {
    name: 'placeholder tags survive a joiner inside',
    input: 'See <i1>the\u2060 docs</i1>',
    expected: 'See <i1>the docs</i1>',
  },
  { name: 'only invisible joiners become empty', input: ISSUE_73_HIDDEN, expected: '' },
  { name: 'CRLF becomes one newline', input: 'a\r\nb', expected: 'a\nb' },
];

describe('sanitizeTranslationInput table', () => {
  it.each(CASES)('$name', ({ input, expected }) => {
    expect(sanitizeTranslationInput(input)).toBe(expected);
    expect(sanitizeTranslationInput(sanitizeTranslationInput(input))).toBe(expected);
  });

  it('aggressive mode still keeps emoji ZWJ but drops Persian ZWNJ', () => {
    expect(sanitizeTranslationInput(FAMILY, 'aggressive')).toBe(FAMILY);
    expect(sanitizeTranslationInput(PERSIAN, 'aggressive')).toBe(
      '\u0645\u06CC\u062E\u0648\u0627\u0647\u0645',
    );
  });

  it('strips a lone surrogate without throwing on NFC', () => {
    const broken = `A${String.fromCharCode(0xd800)}B`;
    expect(stripLoneSurrogates(broken)).toBe('AB');
    expect(sanitizeTranslationInput(broken)).toBe('AB');
  });
});

describe('translatable / runaway detection', () => {
  it('skips a string that is only format characters', () => {
    expect(hasTranslatableText(ISSUE_73_HIDDEN)).toBe(false);
    expect(hasTranslatableText('')).toBe(false);
    expect(hasTranslatableText('   ')).toBe(false);
    expect(hasTranslatableText('Hello.')).toBe(true);
    expect(hasTranslatableText(FAMILY)).toBe(true);
  });

  it('flags output that is only or mostly invisible', () => {
    expect(isInvisibleRunawayOutput('Hello.', '\u200D'.repeat(8))).toBe(true);
    expect(isInvisibleRunawayOutput('Hello.', '\u200D'.repeat(40), true)).toBe(true);
    expect(isInvisibleRunawayOutput('Hello.', 'こんにちは')).toBe(false);
    expect(isInvisibleRunawayOutput(ISSUE_73_HIDDEN, '\u200D'.repeat(8))).toBe(false);
    expect(visibleContent('\u200Dこんにちは\u2060')).toBe('こんにちは');
  });
});

describe('InBrowserEngine Unicode input (wllama and local-server share this path)', () => {
  it('does not send the #73 joiner run to the model', async () => {
    const runtime = new FakeRuntime((prompt) => {
      const source = promptSource(prompt);
      if (/[\u2060\u200C\u200D]/.test(source)) return '\u200D'.repeat(80);
      return 'こんにちは、世界。';
    });
    runtime.fillBudget = true;
    const engine = new InBrowserEngine(runtime);
    const text = `Hello${ISSUE_73_HIDDEN} world.`;
    const chunks = await collectChunks(engine.translate([{ id: 'a', text }], options()));

    expect(promptSource(runtime.requests[0]?.prompt ?? '')).toBe('Hello world.');
    expect(displayed(chunks)).toBe('こんにちは、世界。');
    expect(chunks.at(-1)).toEqual({ id: 'a', final: 'こんにちは、世界。', engine: 'plamo' });
  });

  it('keeps an emoji ZWJ sequence in the prompt', async () => {
    const runtime = new FakeRuntime(() => '家族');
    const engine = new InBrowserEngine(runtime);
    await collectChunks(engine.translate([{ id: 'a', text: `The ${FAMILY} waved.` }], options()));
    expect(promptSource(runtime.requests[0]?.prompt ?? '')).toContain(FAMILY);
  });

  it('keeps Persian ZWNJ in the prompt', async () => {
    const runtime = new FakeRuntime(() => 'I want');
    const engine = new InBrowserEngine(runtime, {});
    await collectChunks(
      engine.translate([{ id: 'a', text: PERSIAN }], options({ tgt: 'en', src: 'fa' })),
    );
    expect(promptSource(runtime.requests[0]?.prompt ?? '')).toBe(PERSIAN);
  });

  it('does not call the model for a segment that is only invisible characters', async () => {
    const runtime = new FakeRuntime(() => 'こんにちは');
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: ISSUE_73_HIDDEN },
          { id: 'b', text: 'Hello.' },
        ],
        options(),
      ),
    );
    expect(runtime.requests).toHaveLength(1);
    expect(promptSource(runtime.requests[0]?.prompt ?? '')).toBe('Hello.');
    expect(chunks).toEqual(
      expect.arrayContaining([
        { id: 'a', final: ISSUE_73_HIDDEN, engine: 'plamo' },
        { id: 'b', final: 'こんにちは', engine: 'plamo' },
      ]),
    );
  });

  it('retracts invisible runaway output and leaves the source instead of showing it', async () => {
    const runtime = new FakeRuntime(() => '\u200D'.repeat(8));
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));
    expect(displayed(chunks)).toBe('Hello.');
    expect(chunks.at(-1)).toMatchObject({ id: 'a', final: 'Hello.', engine: 'plamo', error: true });
  });

  it('retries once with aggressive sanitizing when careful input still collapses', async () => {
    const runtime = new FakeRuntime((prompt) => {
      const source = promptSource(prompt);
      if (source.includes('\u200C')) return '\u200D'.repeat(8);
      return 'I want';
    });
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(
      engine.translate([{ id: 'a', text: PERSIAN }], options({ tgt: 'en', src: 'fa' })),
    );
    expect(runtime.requests.length).toBeGreaterThanOrEqual(2);
    expect(displayed(chunks)).toBe('I want');
    expect(chunks.at(-1)?.error).toBeUndefined();
  });

  it('packs short segments after stripping joiners so line alignment stays 1:1', async () => {
    const runtime = new FakeRuntime((prompt) => {
      const source = promptSource(prompt);
      if (source === `OK\nHi`) return 'はい\nこんにちは';
      return `unexpected:${source}`;
    });
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: `OK${ISSUE_73_HIDDEN}` },
          { id: 'b', text: 'Hi' },
        ],
        options(),
      ),
    );
    expect(runtime.requests).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.final !== undefined)).toEqual([
      { id: 'a', final: 'はい', engine: 'plamo' },
      { id: 'b', final: 'こんにちは', engine: 'plamo' },
    ]);
  });
});

describe('Chrome translator Unicode input', () => {
  it('sends sanitized text to the built-in translator', async () => {
    const seen: string[] = [];
    const instance: TranslatorInstance = {
      translate: async (text) => {
        seen.push(text);
        return `[${text}]`;
      },
    };
    const translator: TranslatorConstructor<TranslatorInstance> = {
      availability: async () => 'available',
      create: async () => instance,
    };
    const engine = new ChromeTranslatorEngine({ translator });
    const chunks = await collectChunks(
      engine.translate([{ id: 'a', text: `Hello${ISSUE_73_HIDDEN}.` }], options({ src: 'en' })),
    );
    expect(seen).toEqual(['Hello.']);
    expect(chunks.at(-1)).toEqual({ id: 'a', final: '[Hello.]', engine: 'chrome' });
  });

  it('skips a Chrome segment that is only invisible characters', async () => {
    let calls = 0;
    const instance: TranslatorInstance = {
      translate: async () => {
        calls += 1;
        return 'nope';
      },
    };
    const translator: TranslatorConstructor<TranslatorInstance> = {
      availability: async () => 'available',
      create: async () => instance,
    };
    const engine = new ChromeTranslatorEngine({ translator });
    const chunks = await collectChunks(
      engine.translate([{ id: 'a', text: ISSUE_73_HIDDEN }], options({ src: 'en' })),
    );
    expect(calls).toBe(0);
    expect(chunks).toEqual([{ id: 'a', final: ISSUE_73_HIDDEN, engine: 'chrome' }]);
  });
});

describe('cache, captions, typed input, cleanModelOutput', () => {
  it('uses the same cache key for the same visible text with extra joiners', () => {
    const base = {
      model: 'plamo-0.8b',
      tgt: 'ja' as const,
      form: 'polite' as const,
      src: 'en',
    };
    expect(buildTranslationCacheKey({ ...base, text: 'Hello world.' })).toBe(
      buildTranslationCacheKey({ ...base, text: `Hello${ISSUE_73_HIDDEN} world.` }),
    );
  });

  it('serves a joiner variant from the cache of the cleaned text', async () => {
    const store = new MemoryTranslationCacheStore();
    const inner = {
      kind: 'plamo' as const,
      calls: 0,
      async *translate(segments: readonly TranslateSegment[]): AsyncIterable<TranslationChunk> {
        this.calls += 1;
        for (const segment of segments) {
          yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' };
        }
      },
    };
    const engine = new CachingEngine(inner, new TranslationCache(store), 'plamo-0.8b');
    await collectChunks(engine.translate([{ id: 'a', text: 'Hello world.' }], options()));
    const second = await collectChunks(
      engine.translate([{ id: 'b', text: `Hello${ISSUE_73_HIDDEN} world.` }], options()),
    );
    expect(inner.calls).toBe(1);
    expect(second).toEqual([{ id: 'b', final: '訳:Hello world.', engine: 'plamo' }]);
  });

  it('strips joiners from caption text and skips an invisible-only cue', async () => {
    expect(normalizeCaptionText(`Hello${ISSUE_73_HIDDEN} world`)).toBe('Hello world');
    let calls = 0;
    const page: PageEngine = {
      async *translate() {
        calls += 1;
        yield* [];
      },
    };
    const translator = new CaptionTranslator(page);
    const result = await translator.translateCue(
      { id: 'c', startMs: 0, endMs: 1000, text: ISSUE_73_HIDDEN },
      { tgt: 'ja', form: 'polite' },
      2,
    );
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it('strips joiners from typed input without collapsing emoji ZWJ', () => {
    expect(normalizeTypedInput(`Hello${ISSUE_73_HIDDEN} world`)).toBe('Hello world');
    expect(normalizeTypedInput(`The ${FAMILY} waved.`)).toBe(`The ${FAMILY} waved.`);
  });

  it('strips runaway joiners from model output after the PFML stop token', () => {
    expect(cleanModelOutput(`こんにちは\u2060 <|plamo:tag|>`)).toBe('こんにちは');
  });
});

describe('DOM write-back after sanitizing for the model', () => {
  it('maps a translation onto the original nodes and restores the joiners', () => {
    document.body.innerHTML = `<p>Hello${ISSUE_73_HIDDEN} <a href="/w">world</a></p>`;
    const block = document.querySelector('p');
    if (!block) throw new Error('missing paragraph');
    const model = buildSegment(block);
    if (!model) throw new Error('missing segment');
    expect(model.source).toContain('\u2060');
    expect(sanitizeTranslationInput(model.source)).toContain('<i1>world</i1>');
    expect(sanitizeTranslationInput(model.source)).not.toMatch(/[\u2060\u200C\u200D]/u);

    const before = block.innerHTML;
    const created: Text[] = [];
    applyTranslation(model, 'こんにちは <i1>世界</i1>', created);
    expect(block.textContent).toContain('こんにちは');
    expect(block.querySelector('a')?.textContent).toBe('世界');
    restoreSegment(model, created);
    expect(block.innerHTML).toBe(before);
  });
});
