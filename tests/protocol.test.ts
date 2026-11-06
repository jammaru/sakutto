import { describe, expect, it } from 'vitest';
import { EngineError } from '@/engine/errors';
import {
  deserializeTranslateOptions,
  errorFromPayload,
  errorPayload,
  isEngineHostMessage,
  isEngineHostRequest,
  isTranslationCancelRequest,
  isTranslationServerMessage,
  isTranslationStartRequest,
  serializeTranslateOptions,
} from '@/engine/offscreen/protocol';
import type { TranslateOptions } from '@/engine/types';

const OPTIONS: TranslateOptions = {
  tgt: 'ja',
  form: 'polite',
  priority: 10,
  src: 'en',
  context: 'Greeting page',
  glossary: [{ source: 'Runner', target: 'ランナー機能' }],
  signal: new AbortController().signal,
};

const SEGMENTS = [{ id: 'a', text: 'Hello.' }];

describe('engine host protocol', () => {
  it('serializes translate options without the signal', () => {
    const serialized = serializeTranslateOptions(OPTIONS);

    expect(serialized).toEqual({
      tgt: 'ja',
      form: 'polite',
      priority: 10,
      src: 'en',
      context: 'Greeting page',
      glossary: [{ source: 'Runner', target: 'ランナー機能' }],
    });

    const signal = new AbortController().signal;
    expect(deserializeTranslateOptions(serialized, signal)).toEqual({
      tgt: 'ja',
      form: 'polite',
      priority: 10,
      src: 'en',
      context: 'Greeting page',
      glossary: [{ source: 'Runner', target: 'ランナー機能' }],
      signal,
    });
  });

  it('validates translate, status and model requests', () => {
    expect(
      isEngineHostRequest({
        type: 'translate',
        requestId: 'r1',
        segments: SEGMENTS,
        options: serializeTranslateOptions(OPTIONS),
      }),
    ).toBe(true);
    expect(isEngineHostRequest({ type: 'status', requestId: 'r2' })).toBe(true);
    expect(isEngineHostRequest({ type: 'ping', requestId: 'r3' })).toBe(true);
    expect(
      isEngineHostRequest({
        type: 'model-download',
        requestId: 'r4',
        modelId: 'plamo-3-translate-0.8b-q4_k_m',
      }),
    ).toBe(true);
    expect(
      isEngineHostRequest({
        type: 'model-use',
        requestId: 'r5',
        modelId: 'plamo-3-translate-2b-q4_k_m',
      }),
    ).toBe(true);

    expect(isEngineHostRequest({ type: 'status' })).toBe(false);
    expect(
      isEngineHostRequest({ type: 'translate', requestId: 'r', segments: [], options: {} }),
    ).toBe(false);
    expect(isEngineHostRequest({ type: 'model-delete', requestId: 'r', modelId: 'unknown' })).toBe(
      false,
    );
  });

  it('bounds priorities, segment counts and message sizes', () => {
    const options = serializeTranslateOptions(OPTIONS);
    const request = (overrides: Record<string, unknown>) => ({
      type: 'translate',
      requestId: 'r1',
      segments: SEGMENTS,
      options: { ...options, ...overrides },
    });

    expect(isEngineHostRequest(request({ priority: Number.NaN }))).toBe(false);
    expect(isEngineHostRequest(request({ priority: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(isEngineHostRequest(request({ priority: 101 }))).toBe(false);
    expect(isEngineHostRequest(request({ priority: -101 }))).toBe(false);
    expect(isEngineHostRequest(request({ tgt: 'english' }))).toBe(false);
    expect(isEngineHostRequest(request({ tgt: 'pt' }))).toBe(true);
    expect(isEngineHostRequest(request({ eager: true }))).toBe(true);
    expect(isEngineHostRequest(request({ eager: 'yes' }))).toBe(false);
    // Draft and preview options are gone: the host never paints built-in page text.
    expect(isEngineHostRequest(request({ draft: true }))).toBe(true);
    expect(isEngineHostRequest({ type: 'benchmark', requestId: 'b1' })).toBe(true);
    expect(isEngineHostRequest({ type: 'cache-clear', requestId: 'c1' })).toBe(true);
    expect(isEngineHostRequest({ type: 'tier-set', requestId: 't1', tier: 'auto' })).toBe(true);
    expect(isEngineHostRequest({ type: 'tier-set', requestId: 't1', tier: 'fast' })).toBe(false);
    expect(isEngineHostRequest(request({ src: 'e'.repeat(36) }))).toBe(false);
    expect(isEngineHostRequest(request({ context: 'x'.repeat(20_001) }))).toBe(false);
    expect(
      isEngineHostRequest(
        request({ glossary: Array.from({ length: 1001 }, () => ({ source: 'a', target: 'b' })) }),
      ),
    ).toBe(false);
    expect(
      isEngineHostRequest({
        type: 'translate',
        requestId: 'r1',
        segments: Array.from({ length: 2001 }, (_, index) => ({ id: String(index), text: 'x' })),
        options,
      }),
    ).toBe(false);
    expect(
      isEngineHostRequest({
        type: 'translate',
        requestId: 'r1',
        segments: [{ id: 'a', text: 'x'.repeat(20_001) }],
        options,
      }),
    ).toBe(false);
  });

  it('validates host events and rejects malformed ones', () => {
    expect(
      isEngineHostMessage({
        type: 'chunk',
        requestId: 'r1',
        chunk: { id: 'a', textDelta: 'こん', engine: 'plamo' },
      }),
    ).toBe(true);
    expect(isEngineHostMessage({ type: 'done', requestId: 'r1' })).toBe(true);
    expect(
      isEngineHostMessage({
        type: 'model-progress',
        requestId: 'r1',
        status: {
          id: 'plamo-3-translate-0.8b-q4_k_m',
          state: 'downloading',
          received: 1,
          total: 2,
          progress: 0.5,
        },
      }),
    ).toBe(true);
    expect(isEngineHostMessage({ type: 'response', requestId: 'r1', ok: true, value: null })).toBe(
      true,
    );
    expect(
      isEngineHostMessage({
        type: 'response',
        requestId: 'r1',
        ok: false,
        error: { code: 'aborted', message: 'x' },
      }),
    ).toBe(true);

    expect(
      isEngineHostMessage({
        type: 'chunk',
        requestId: 'r1',
        chunk: { id: 'a', textDelta: '訳', engine: 'plamo', restart: true },
      }),
    ).toBe(true);
    expect(
      isEngineHostMessage({
        type: 'chunk',
        requestId: 'r1',
        chunk: { id: 'a', final: '訳', engine: 'plamo', restart: true },
      }),
    ).toBe(false);
    expect(
      isEngineHostMessage({
        type: 'chunk',
        requestId: 'r1',
        chunk: { id: 'a', textDelta: '訳', engine: 'plamo', restart: 'yes' },
      }),
    ).toBe(false);
    expect(isEngineHostMessage({ type: 'chunk', requestId: 'r1', chunk: { id: 'a' } })).toBe(false);
    expect(isEngineHostMessage({ type: 'done' })).toBe(false);
    expect(isEngineHostMessage({ type: 'response', requestId: 'r1', ok: true })).toBe(false);
    expect(
      isEngineHostMessage({
        type: 'response',
        requestId: 'r1',
        ok: false,
        error: { code: 'nope', message: 'x' },
      }),
    ).toBe(false);
  });

  it('validates the caller port messages', () => {
    expect(
      isTranslationStartRequest({
        type: 'start',
        requestId: 'r1',
        segments: SEGMENTS,
        options: serializeTranslateOptions(OPTIONS),
      }),
    ).toBe(true);
    expect(isTranslationCancelRequest({ type: 'cancel', requestId: 'r1' })).toBe(true);
    expect(isTranslationStartRequest({ type: 'start', requestId: 'r1' })).toBe(false);
    expect(isTranslationServerMessage({ type: 'done', requestId: 'r1' })).toBe(true);
    expect(
      isTranslationServerMessage({
        type: 'error',
        requestId: 'r1',
        error: { code: 'model-missing', message: 'x' },
      }),
    ).toBe(true);
    expect(isTranslationServerMessage({ type: 'chunk', requestId: 'r1' })).toBe(false);
  });

  it('round-trips engine errors', () => {
    const error = new EngineError('model-integrity', 'digest mismatch');
    expect(errorPayload(error)).toEqual({ code: 'model-integrity', message: 'digest mismatch' });
    expect(errorFromPayload(errorPayload(error))).toMatchObject({
      code: 'model-integrity',
      message: 'digest mismatch',
    });
    expect(errorPayload('plain')).toEqual({ code: 'unknown', message: 'plain' });
  });
});
