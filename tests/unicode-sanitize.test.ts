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
import { EngineError, isLengthTruncation } from '@/engine/errors';
import { InBrowserEngine } from '@/engine/in-browser/engine';
import type { CompletionRequest, CompletionResult } from '@/engine/in-browser/runtime';
import { cleanModelOutput } from '@/engine/prompt/pfml3';
import {
  ISSUE_73_HIDDEN,
  hasTranslatableText,
  isInvisibleRunawayOutput,
  sanitizeModelOutput,
  sanitizeTranslationInput,
  stripLoneSurrogates,
  visibleContent,
} from '@/engine/text/sanitize';
import { completionTokenBudget } from '@/engine/text/tokens';
import type { PageEngine } from '@/dom/session';
import type { TranslateOptions, TranslateSegment, TranslationChunk } from '@/engine/types';
import { applyTypedChunk, normalizeTypedInput } from '@/shared/typed-translation';
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
const SCOTLAND_FLAG =
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E006C}\u{E0061}\u{E006E}\u{E0064}\u{E007F}';
const SCOTLAND_GBSCT = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
const PIRATE_FLAG = '\u{1F3F4}\u200D\u2620\uFE0F';
const FAMILY = '👨\u200D👩\u200D👧\u200D👦';
const FROM_ENGLAND = `I am from England ${ENGLAND_FLAG} and I love tea.`;
const GO_ENGLAND = `Go England! ${ENGLAND_FLAG}`;
const FROM_SCOTLAND = `I am from Scotland ${SCOTLAND_GBSCT}.`;
const PERSIAN = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';
const PERSIAN_TAG = '\u06a9\u062a\u0627\u0628\u200c<i1>\u0647\u0627</i1>';
const EMOJI_TAG = '👨\u200d<i1>👩</i1>';
const HINDI_ZWNJ = '\u0915\u094D\u200C\u0937';
const MALAYALAM_CHILLU = '\u0d05\u0d35\u0d7b';
const MALAYALAM_CHILLU_ZWJ = '\u0d05\u0d35\u0d28\u0d4d\u200d';
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
  { name: 'Persian ZWNJ across a placeholder tag', input: PERSIAN_TAG, expected: PERSIAN_TAG },
  { name: 'emoji ZWJ across a placeholder tag', input: EMOJI_TAG, expected: EMOJI_TAG },
  { name: 'Hindi virama + ZWNJ', input: HINDI_ZWNJ, expected: HINDI_ZWNJ },
  {
    name: 'Malayalam chillu precomposed',
    input: MALAYALAM_CHILLU,
    expected: MALAYALAM_CHILLU,
  },
  {
    name: 'Malayalam chillu virama + ZWJ at word end',
    input: MALAYALAM_CHILLU_ZWJ,
    expected: MALAYALAM_CHILLU_ZWJ,
  },
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
    expect(sanitizeTranslationInput(MALAYALAM_CHILLU_ZWJ, 'aggressive')).toBe(MALAYALAM_CHILLU_ZWJ);
    expect(sanitizeTranslationInput(EMOJI_TAG, 'aggressive')).toBe(EMOJI_TAG);
  });

  it('scans a long joiner run in linear time', () => {
    const input = `aa${'\u200D'.repeat(32_000)}bb`;
    const started = Date.now();
    expect(sanitizeTranslationInput(input)).toBe('aabb');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('skips neighbor tables when the text has no joiners or placeholders', () => {
    const input = `${'Hello world. '.repeat(2000)}Fine.`;
    const started = Date.now();
    expect(sanitizeTranslationInput(input).startsWith('Hello world.')).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
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

  it('ignores placeholder tags when deciding whether text is translatable', () => {
    expect(hasTranslatableText('<i1></i1>')).toBe(false);
    expect(hasTranslatableText('</i12>')).toBe(false);
    expect(hasTranslatableText('<i1>Hi</i1>')).toBe(true);
    expect(hasTranslatableText('<i1></i1>Hello')).toBe(true);
  });

  it('flags output that is only or mostly invisible', () => {
    expect(isInvisibleRunawayOutput('Hello.', '\u200D'.repeat(8))).toBe(true);
    expect(isInvisibleRunawayOutput('Hello.', '\u200D'.repeat(40), true)).toBe(true);
    expect(isInvisibleRunawayOutput('Hello.', 'こんにちは')).toBe(false);
    expect(isInvisibleRunawayOutput(ISSUE_73_HIDDEN, '\u200D'.repeat(8))).toBe(false);
    expect(visibleContent('\u200Dこんにちは\u2060')).toBe('こんにちは');
  });

  it('does not treat a short translation plus a few trailing joiners as a runaway', () => {
    expect(isInvisibleRunawayOutput('Hello.', `設定${'\u200D'.repeat(8)}`)).toBe(false);
    expect(isInvisibleRunawayOutput('Hello.', `設定${'\u200D'.repeat(8)}`, true)).toBe(false);
    expect(isInvisibleRunawayOutput('Hello.', `設定${'\u2060'.repeat(8)}`)).toBe(false);
  });

  it('flags a short translation buried under a joiner storm', () => {
    expect(isInvisibleRunawayOutput('Hello.', `設定${'\u200D'.repeat(16)}`)).toBe(true);
    expect(isInvisibleRunawayOutput('Hello.', `設定${'\u200D'.repeat(40)}`)).toBe(true);
    expect(isInvisibleRunawayOutput('Hello.', `あ${'\u200D'.repeat(200)}`)).toBe(true);
    expect(isInvisibleRunawayOutput('Hello.', '\u200D'.repeat(80))).toBe(true);
  });

  it('does not treat a subdivision flag tag sequence as a runaway', () => {
    expect(isInvisibleRunawayOutput('Hello.', ENGLAND_FLAG)).toBe(false);
    expect(isInvisibleRunawayOutput('Hello.', ENGLAND_FLAG, true)).toBe(false);
    expect(isInvisibleRunawayOutput('Hello.', SCOTLAND_FLAG)).toBe(false);
    expect(isInvisibleRunawayOutput('Hello.', SCOTLAND_FLAG, true)).toBe(false);
    expect(isInvisibleRunawayOutput('Hello.', ENGLAND_FLAG.repeat(3))).toBe(false);
    expect(isInvisibleRunawayOutput('Hello.', ENGLAND_FLAG.repeat(5))).toBe(false);
    expect(isInvisibleRunawayOutput('UK nations', ENGLAND_FLAG.repeat(3), true)).toBe(false);
    expect(isInvisibleRunawayOutput('UK nations', ENGLAND_FLAG.repeat(10), true)).toBe(false);
  });

  it('uses hitMaxTokens as an extra runaway signal for a joiner tail', () => {
    const truncated = `Hel${'\u200D'.repeat(20)}`;
    expect(isInvisibleRunawayOutput('Hello.', truncated)).toBe(false);
    expect(isInvisibleRunawayOutput('Hello.', truncated, true)).toBe(true);
  });

  it('flags an RTL joiner storm that the output sanitizer keeps', () => {
    const storm = `\u0645${'\u200C\u200D'.repeat(100)}\u0631`;
    expect(isInvisibleRunawayOutput('Hello world.', `Hello ${storm}`)).toBe(true);
    expect(isInvisibleRunawayOutput('Hello world.', `Hello ${storm}`, true)).toBe(true);

    const bidi = [0x200c, 0x200d, 0x200f, 0x202b, 0x202e, 0x2067];
    let mixed = '\u0645';
    for (let index = 0; index < 120; index += 1) {
      mixed += String.fromCodePoint(bidi[index % bidi.length]!);
    }
    mixed += '\u0631';
    expect(isInvisibleRunawayOutput('Hello world.', `Hi ${mixed}`)).toBe(true);
    expect(isInvisibleRunawayOutput('Hello world.', `Hi ${mixed}`, true)).toBe(true);
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

  it('keeps a Malayalam chillu ZWJ in the prompt', async () => {
    const runtime = new FakeRuntime(() => 'he');
    const engine = new InBrowserEngine(runtime);
    await collectChunks(
      engine.translate(
        [{ id: 'a', text: MALAYALAM_CHILLU_ZWJ }],
        options({ tgt: 'en', src: 'ml' }),
      ),
    );
    expect(promptSource(runtime.requests[0]?.prompt ?? '')).toBe(MALAYALAM_CHILLU_ZWJ);
  });

  it('keeps joiners adjacent to placeholder tags in the prompt', async () => {
    const runtime = new FakeRuntime(() => 'book');
    const engine = new InBrowserEngine(runtime);
    await collectChunks(
      engine.translate([{ id: 'a', text: PERSIAN_TAG }], options({ tgt: 'en', src: 'fa' })),
    );
    expect(promptSource(runtime.requests[0]?.prompt ?? '')).toBe(PERSIAN_TAG);

    runtime.handler = () => 'family';
    await collectChunks(engine.translate([{ id: 'b', text: EMOJI_TAG }], options()));
    expect(promptSource(runtime.requests.at(-1)?.prompt ?? '')).toBe(EMOJI_TAG);
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

  it('falls back to the untouched original when Latin runaway cannot retry', async () => {
    const runtime = new FakeRuntime(() => '\u200D'.repeat(8));
    const engine = new InBrowserEngine(runtime);
    const text = `Hello${ISSUE_73_HIDDEN}.`;
    const chunks = await collectChunks(engine.translate([{ id: 'a', text }], options()));
    expect(runtime.requests).toHaveLength(1);
    expect(displayed(chunks)).toBe(text);
    expect(chunks.at(-1)).toMatchObject({ id: 'a', final: text, engine: 'plamo', error: true });
  });

  it('keeps a short translation that only has a few trailing joiners', async () => {
    const runtime = new FakeRuntime(() => `設定${'\u200D'.repeat(8)}`);
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));
    expect(runtime.requests).toHaveLength(1);
    expect(displayed(chunks)).toBe('設定');
    expect(chunks.at(-1)?.error).toBeUndefined();
  });

  it('salvages a real translation buried under joiners instead of failing', async () => {
    const runtime = new FakeRuntime(() => `設定${'\u200D'.repeat(40)}`);
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));
    expect(runtime.requests).toHaveLength(1);
    expect(displayed(chunks)).toBe('設定');
    expect(chunks.at(-1)?.error).toBeUndefined();
  });

  it('salvages a good translation followed by the #73 fixture', async () => {
    const runtime = new FakeRuntime(() => `こんにちは、世界。${ISSUE_73_HIDDEN.repeat(3)}`);
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));
    expect(displayed(chunks)).toBe('こんにちは、世界。');
    expect(chunks.at(-1)?.error).toBeUndefined();
  });

  it('does not salvage a truncated translation that hit max tokens', async () => {
    const truncated = `これは途中で切れた翻訳です${ISSUE_73_HIDDEN.repeat(4)}`;
    class TruncatedRuntime extends FakeRuntime {
      override async complete(request: CompletionRequest): Promise<CompletionResult | void> {
        this.requests.push(request);
        request.onToken(truncated);
        return { hitMaxTokens: true };
      }
    }
    const store = new MemoryTranslationCacheStore();
    const cache = new TranslationCache(store);
    const engine = new CachingEngine(
      new InBrowserEngine(new TruncatedRuntime(() => truncated)),
      cache,
      'plamo-test',
    );
    const key = buildTranslationCacheKey({
      model: 'plamo-test',
      tgt: 'ja',
      form: 'polite',
      text: 'Hello.',
      src: 'en',
    });
    const chunks = await collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options({ src: 'en' })),
    );
    expect(chunks.at(-1)?.error).toBe(true);
    expect(chunks.at(-1)?.final).not.toBe('これは途中で切れた翻訳です');
    expect(await cache.get(key)).toBeUndefined();
  });

  it('does not pack U+2028 or CRLF into a one-line batch', async () => {
    const runtime = new FakeRuntime((prompt) => {
      const source = promptSource(prompt);
      if (source === 'First\nSecond') return '訳A';
      if (source === 'Other') return '訳B';
      return `unexpected:${source}`;
    });
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'First\u2028Second' },
          { id: 'b', text: 'Other' },
        ],
        options(),
      ),
    );
    expect(chunks.filter((chunk) => chunk.final !== undefined)).toEqual([
      { id: 'a', final: '訳A', engine: 'plamo' },
      { id: 'b', final: '訳B', engine: 'plamo' },
    ]);

    runtime.handler = (prompt) => {
      const source = promptSource(prompt);
      if (source === 'Alpha\nBeta') return '訳C';
      if (source === 'Gamma') return '訳D';
      return `unexpected:${source}`;
    };
    const crlf = await collectChunks(
      engine.translate(
        [
          { id: 'c', text: 'Alpha\r\nBeta' },
          { id: 'd', text: 'Gamma' },
        ],
        options(),
      ),
    );
    expect(crlf.filter((chunk) => chunk.final !== undefined)).toEqual([
      { id: 'c', final: '訳C', engine: 'plamo' },
      { id: 'd', final: '訳D', engine: 'plamo' },
    ]);
  });

  it('falls back to the page original bytes on a failed batch', async () => {
    const runtime = new FakeRuntime(() => '\u200D'.repeat(8));
    const engine = new InBrowserEngine(runtime);
    const first = 'Hello\u00A0there.';
    const second = 'Hi\u00A0you.';
    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: first },
          { id: 'b', text: second },
        ],
        options(),
      ),
    );
    const finals = chunks.filter((chunk) => chunk.final !== undefined);
    expect(finals).toEqual([
      { id: 'a', final: first, engine: 'plamo', error: true },
      { id: 'b', final: second, engine: 'plamo', error: true },
    ]);
  });

  it('falls back to original NBSP bytes after an oversized recover', async () => {
    const first = 'Hello\u00A0there tonight around the harbour lights.';
    const second = 'Next\u00A0line stays here for the recover path.';
    const text = `${first} ${second}`;
    const runtime = new FakeRuntime(() => '\u200D'.repeat(8));
    runtime.complete = async (request) => {
      runtime.requests.push(request);
      const source = promptSource(request.prompt);
      if (source.includes('Hello') && source.includes('Next')) {
        throw new EngineError('invalid-input', 'The segment does not fit in the context window.');
      }
      request.onToken('\u200D'.repeat(8));
      return { hitMaxTokens: true };
    };
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(engine.translate([{ id: 'a', text }], options()));
    expect(chunks.at(-1)?.error).toBe(true);
    expect(chunks.at(-1)?.final).toContain('\u00A0');
    expect(chunks.at(-1)?.final).not.toBe(text.replaceAll('\u00A0', ' '));
  });

  it('keeps a subdivision flag in model output', async () => {
    const runtime = new FakeRuntime(() => ENGLAND_FLAG);
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'England' }], options()));
    expect(displayed(chunks)).toBe(ENGLAND_FLAG);
    expect(chunks.at(-1)?.error).toBeUndefined();
  });

  it('keeps several subdivision flags in model output', async () => {
    const runtime = new FakeRuntime(() => ENGLAND_FLAG.repeat(3));
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'UK' }], options()));
    expect(displayed(chunks)).toBe(ENGLAND_FLAG.repeat(3));
    expect(chunks.at(-1)?.error).toBeUndefined();
  });

  it('strips a copied #73 fixture off a good translation', async () => {
    const runtime = new FakeRuntime(() => `こんにちは、世界。${ISSUE_73_HIDDEN.repeat(2)}`);
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));
    expect(displayed(chunks)).toBe('こんにちは、世界。');
    expect(chunks.at(-1)?.error).toBeUndefined();
  });

  it('asks for enough completion tokens on flag and emoji sentences', async () => {
    const runtime = new FakeRuntime(() => '訳');
    const engine = new InBrowserEngine(runtime);
    for (const text of [FROM_ENGLAND, GO_ENGLAND, FROM_SCOTLAND, `The ${FAMILY} waved.`]) {
      runtime.requests.length = 0;
      await collectChunks(engine.translate([{ id: 'a', text }], options()));
      expect(runtime.requests[0]?.maxTokens).toBeGreaterThan(32);
      expect(runtime.requests[0]?.maxTokens).toBe(completionTokenBudget(text));
    }
  });

  it('restarts every painted batch segment when a packed retry starts over', async () => {
    const first = 'イングランド\nスコットランド\nウェールズ';
    const second = 'イングランドです\nスコットランドです\nウェールズです';
    class BatchRetryRuntime extends FakeRuntime {
      override async complete(request: CompletionRequest): Promise<CompletionResult | void> {
        this.requests.push(request);
        if (this.requests.length === 1) {
          request.onToken(first);
          return { hitMaxTokens: true };
        }
        request.onToken(second);
        return { hitMaxTokens: false };
      }
    }
    const runtime = new BatchRetryRuntime(() => first);
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'England' },
          { id: 'b', text: 'Scotland' },
          { id: 'c', text: 'Wales' },
        ],
        options(),
      ),
    );

    expect(runtime.requests).toHaveLength(2);
    const painted: Record<string, string> = { a: '', b: '', c: '' };
    const restarted = new Set<string>();
    for (const chunk of chunks) {
      if (chunk.textDelta === undefined) continue;
      if (chunk.restart === true) restarted.add(chunk.id);
      painted[chunk.id] =
        chunk.restart === true ? chunk.textDelta : (painted[chunk.id] ?? '') + chunk.textDelta;
      expect(painted[chunk.id]).not.toContain('イングランドイングランド');
      expect(painted[chunk.id]).not.toContain('スコットランドスコットランド');
      expect(painted[chunk.id]).not.toContain('ウェールズウェールズ');
    }
    expect(restarted).toEqual(new Set(['a', 'b', 'c']));
    expect(chunks.filter((chunk) => chunk.final !== undefined)).toEqual([
      { id: 'a', final: 'イングランドです', engine: 'plamo' },
      { id: 'b', final: 'スコットランドです', engine: 'plamo' },
      { id: 'c', final: 'ウェールズです', engine: 'plamo' },
    ]);
  });

  it('retries a visible hitMaxTokens completion with a larger budget', async () => {
    const truncated = `イングランド出身です ${ENGLAND_FLAG} お茶`;
    const finished = `イングランド出身です ${ENGLAND_FLAG} お茶が大好きです。`;
    class RetryRuntime extends FakeRuntime {
      override async complete(request: CompletionRequest): Promise<CompletionResult | void> {
        this.requests.push(request);
        if (this.requests.length === 1) {
          request.onToken(truncated);
          return { hitMaxTokens: true };
        }
        request.onToken(finished);
        return { hitMaxTokens: false };
      }
    }
    const runtime = new RetryRuntime(() => truncated);
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(
      engine.translate([{ id: 'a', text: FROM_ENGLAND }], options()),
    );
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[1]?.maxTokens).toBeGreaterThan(runtime.requests[0]?.maxTokens ?? 0);
    expect(displayed(chunks)).toBe(finished);
    expect(chunks.at(-1)?.error).toBeUndefined();
  });

  it('does not show or cache a visible-only hitMaxTokens truncation', async () => {
    const truncated = `イングランド出身です ${ENGLAND_FLAG} お茶`;
    class TruncatedRuntime extends FakeRuntime {
      override async complete(request: CompletionRequest): Promise<CompletionResult | void> {
        this.requests.push(request);
        request.onToken(truncated);
        return { hitMaxTokens: true };
      }
    }
    const store = new MemoryTranslationCacheStore();
    const cache = new TranslationCache(store);
    const runtime = new TruncatedRuntime(() => truncated);
    const engine = new CachingEngine(new InBrowserEngine(runtime), cache, 'plamo-test');
    const key = buildTranslationCacheKey({
      model: 'plamo-test',
      tgt: 'ja',
      form: 'polite',
      text: FROM_ENGLAND,
      src: 'en',
    });
    const chunks = await collectChunks(
      engine.translate([{ id: 'a', text: FROM_ENGLAND }], options({ src: 'en' })),
    );
    expect(runtime.requests.length).toBeGreaterThanOrEqual(1);
    expect(displayed(chunks)).toBe(FROM_ENGLAND);
    expect(chunks.at(-1)).toMatchObject({
      id: 'a',
      final: FROM_ENGLAND,
      engine: 'plamo',
      error: true,
    });
    expect(await cache.get(key)).toBeUndefined();

    const typed = chunks.reduce((state, chunk) => applyTypedChunk(state, chunk), {
      text: '',
      failed: false,
    });
    expect(typed.failed).toBe(true);
    expect(typed.text).toBe('');
  });

  it('does not keep a truncated visible completion in captions', async () => {
    const truncated = `私はイギリス出身で\u{1F3F4}`;
    class TruncatedRuntime extends FakeRuntime {
      override async complete(request: CompletionRequest): Promise<CompletionResult | void> {
        this.requests.push(request);
        request.onToken(truncated);
        return { hitMaxTokens: true };
      }
    }
    const translator = new CaptionTranslator(
      new InBrowserEngine(new TruncatedRuntime(() => truncated)),
    );
    const result = await translator.translateCue(
      { id: 'c', startMs: 0, endMs: 1000, text: FROM_ENGLAND },
      { tgt: 'ja', form: 'polite' },
      2,
    );
    expect(result).toBeNull();
    expect(translator.getCached(FROM_ENGLAND, { tgt: 'ja', form: 'polite' })).toBeUndefined();
  });

  it('rethrows a visible length truncation after tokens were forwarded', async () => {
    const error = new EngineError(
      'server-failed',
      'The local translation server stopped early (length).',
      { detail: 'length' },
    );
    expect(isLengthTruncation(error)).toBe(true);

    class LengthRuntime extends FakeRuntime {
      override async complete(request: CompletionRequest): Promise<CompletionResult | void> {
        this.requests.push(request);
        request.onToken('Hel');
        throw error;
      }
    }

    const runtime = new LengthRuntime(() => 'Hel');
    const engine = new InBrowserEngine(runtime);
    await expect(
      collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options())),
    ).rejects.toMatchObject({ code: 'server-failed', detail: 'length' });
    expect(runtime.requests).toHaveLength(1);
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

  it('does not strip a Malayalam chillu ZWJ from model output', () => {
    expect(sanitizeModelOutput(MALAYALAM_CHILLU_ZWJ)).toBe(MALAYALAM_CHILLU_ZWJ);
    expect(cleanModelOutput(MALAYALAM_CHILLU_ZWJ)).toBe(MALAYALAM_CHILLU_ZWJ);
    expect(cleanModelOutput(`${MALAYALAM_CHILLU_ZWJ}<|plamo:tag|>`)).toBe(MALAYALAM_CHILLU_ZWJ);
    expect(cleanModelOutput(MALAYALAM_CHILLU)).toBe(MALAYALAM_CHILLU);
  });

  it('strips Latin bidi overrides and junk tags from model output', () => {
    expect(sanitizeModelOutput('こんにちは\u202E世界')).toBe('こんにちは世界');
    expect(sanitizeModelOutput('Hi\u2066there')).toBe('Hithere');
    expect(sanitizeModelOutput('Hi\u{E0020}there')).toBe('Hithere');
    expect(sanitizeModelOutput(ENGLAND_FLAG)).toBe(ENGLAND_FLAG);
    expect(sanitizeModelOutput(`設定${'\u200D'.repeat(16)}`)).toBe('設定');
    expect(sanitizeModelOutput('\u0633\u0644\u0627\u0645\u200F')).toBe(
      '\u0633\u0644\u0627\u0645\u200F',
    );
  });

  it('does not paint a broken or partial emoji tag sequence', () => {
    const partial = `\u{1F3F4}\u{E0067}\u{E0062}`;
    expect(sanitizeModelOutput(`私はイギリス出身で${partial}`)).toBe('私はイギリス出身で');
    expect(sanitizeModelOutput(`私はイギリス出身で${partial}`)).not.toContain('\u{1F3F4}');
    expect(cleanModelOutput(`私はイギリス出身で${partial}`)).toBe('私はイギリス出身で');
    expect(sanitizeModelOutput(ENGLAND_FLAG)).toBe(ENGLAND_FLAG);
    expect(sanitizeModelOutput(SCOTLAND_GBSCT)).toBe(SCOTLAND_GBSCT);
    expect(sanitizeModelOutput(PIRATE_FLAG)).toBe(PIRATE_FLAG);
  });

  it('keeps Khmer inherent vowels after a Khmer base', () => {
    const khmerAq = '\u1780\u17B4';
    const khmerAa = '\u1780\u17B5';
    expect(sanitizeTranslationInput(khmerAq)).toBe(khmerAq);
    expect(sanitizeTranslationInput(khmerAa)).toBe(khmerAa);
    expect(sanitizeModelOutput(khmerAq)).toBe(khmerAq);
    expect(sanitizeModelOutput(khmerAa)).toBe(khmerAa);
    expect(sanitizeTranslationInput('a\u17B4b')).toBe('ab');
    expect(sanitizeTranslationInput('a\u17B5b')).toBe('ab');
    expect(sanitizeModelOutput('a\u17B4b')).toBe('ab');
  });

  it('keeps Khmer U+17B4 and U+17B5 in km input', () => {
    const km = '\u1780\u17B4\u1781\u17B5';
    expect(sanitizeTranslationInput(km)).toBe(km);
  });

  it('trims trailing joiner runs except a chillu ZWJ', () => {
    expect(cleanModelOutput(`こんにちは${'\u200D'.repeat(8)}`)).toBe('こんにちは');
    expect(cleanModelOutput(MALAYALAM_CHILLU_ZWJ)).toBe(MALAYALAM_CHILLU_ZWJ);
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
