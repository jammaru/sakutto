import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CachingEngine } from '@/engine/cache/caching-engine';
import { TranslationCache } from '@/engine/cache/cache';
import { buildTranslationCacheKey } from '@/engine/cache/key';
import { MemoryTranslationCacheStore } from '@/engine/cache/store';
import { InBrowserEngine } from '@/engine/in-browser/engine';
import { EngineError, isLocalServerError } from '@/engine/errors';
import {
  completeOnServer,
  completionBody,
  listServerModels,
  testLocalServer,
  type LocalServerConfig,
} from '@/engine/local-server/client';
import { LocalServerRuntime } from '@/engine/local-server/runtime';
import { PlamoSourceEngine } from '@/engine/local-server/source';
import {
  DEFAULT_LOCAL_SERVER_PARALLEL,
  DEFAULT_LOCAL_SERVER_URL,
  isLoopbackHostname,
  isRemoteServerUrl,
  normalizeParallel,
  normalizeServerUrl,
  originPatternsFor,
  parseServerUrl,
  primaryOriginPattern,
  serverOriginKey,
} from '@/engine/local-server/url';
import { buildTranslationPrompt, PFML3, TRANSLATION_STOP_TOKENS } from '@/engine/prompt/pfml3';
import { ISSUE_73_HIDDEN } from '@/engine/text/sanitize';
import type { TranslateOptions } from '@/engine/types';
import { collectChunks, FakeRuntime, fakeEngine } from './support/fakes';

interface RecordedRequest {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function startFakeServer(
  handler: (request: IncomingMessage, response: ServerResponse, recorded: RecordedRequest) => void,
): Promise<{ url: string; close: () => Promise<void>; recorded: RecordedRequest[] }> {
  const recorded: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      const entry: RecordedRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '',
        body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : null,
      };
      recorded.push(entry);
      handler(request, response, entry);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    recorded,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function config(url: string, overrides: Partial<LocalServerConfig> = {}): LocalServerConfig {
  return {
    baseUrl: url,
    model: 'pfnet/plamo-3-translate-0.8b-MLX-4bit',
    apiKey: '',
    timeoutMs: 5_000,
    allowRemote: false,
    parallel: 4,
    ...overrides,
  };
}

function options(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
  return {
    tgt: 'ja',
    form: 'polite',
    priority: 10,
    src: 'en',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function jsonStop(text: string): string {
  return JSON.stringify({ choices: [{ text, finish_reason: 'stop' }] });
}

function writeModels(response: ServerResponse, ids: readonly string[]): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
}

function handleModelsAndCompletion(
  response: ServerResponse,
  request: IncomingMessage,
  text = 'こんにちは',
): void {
  if ((request.url ?? '').includes('/models')) {
    writeModels(response, ['pfnet/plamo-3-translate-0.8b-MLX-4bit', 'other']);
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(jsonStop(text));
}

describe('local server URL', () => {
  it('normalises a host without /v1 and keeps a completions path off the stored URL', () => {
    expect(normalizeServerUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/v1');
    expect(normalizeServerUrl('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080/v1');
    expect(parseServerUrl('http://localhost:1234/v1')?.completionsUrl).toBe(
      'http://localhost:1234/v1/completions',
    );
    expect(normalizeServerUrl('not a url')).toBe(DEFAULT_LOCAL_SERVER_URL);
  });

  it('defaults concurrent completions to 8', () => {
    expect(DEFAULT_LOCAL_SERVER_PARALLEL).toBe(8);
    expect(normalizeParallel(undefined)).toBe(8);
    expect(normalizeParallel(4)).toBe(4);
  });

  it('treats loopback names as local and everything else as remote', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('127.0.0.8')).toBe(true);
    expect(isRemoteServerUrl('http://127.0.0.1:8080/v1')).toBe(false);
    expect(isRemoteServerUrl('http://192.168.1.5:1234/v1')).toBe(true);
    expect(isRemoteServerUrl('https://example.test/v1')).toBe(true);
  });

  it('rejects lookalike hosts, userinfo, and authority tricks', () => {
    expect(isRemoteServerUrl('http://localhost.evil.com/v1')).toBe(true);
    expect(isRemoteServerUrl('http://127.0.0.1.nip.io/v1')).toBe(true);
    expect(parseServerUrl('http://user@127.0.0.1/v1')).toBeNull();
    expect(parseServerUrl('http://127.0.0.1:8080@evil.com/v1')).toBeNull();
    expect(isRemoteServerUrl('http://user@127.0.0.1/v1')).toBe(true);
    expect(isRemoteServerUrl('http://127.0.0.1:8080@evil.com/v1')).toBe(true);
  });

  it('treats a trailing-dot localhost as loopback', () => {
    expect(isLoopbackHostname('localhost.')).toBe(true);
    expect(isRemoteServerUrl('http://localhost./v1')).toBe(false);
    expect(parseServerUrl('http://localhost./v1')?.hostname).toBe('localhost.');
  });

  it('treats IPv4-mapped loopback as local', () => {
    expect(isLoopbackHostname('[::ffff:127.0.0.1]')).toBe(true);
    expect(isLoopbackHostname('[::ffff:7f00:1]')).toBe(true);
    expect(isLoopbackHostname('::ffff:127.0.0.1')).toBe(true);
    expect(isRemoteServerUrl('http://[::ffff:127.0.0.1]/v1')).toBe(false);
    expect(isLoopbackHostname('[::ffff:c0a8:1]')).toBe(false);
  });

  it('accepts decimal, hex and compact spellings the URL parser canonicalises to 127.0.0.1', () => {
    expect(parseServerUrl('http://2130706433/v1')?.hostname).toBe('127.0.0.1');
    expect(isRemoteServerUrl('http://2130706433/v1')).toBe(false);
    expect(parseServerUrl('http://0x7f000001/v1')?.hostname).toBe('127.0.0.1');
    expect(isRemoteServerUrl('http://0x7f000001/v1')).toBe(false);
    expect(parseServerUrl('http://0177.0.0.1/v1')?.hostname).toBe('127.0.0.1');
    expect(isRemoteServerUrl('http://0177.0.0.1/v1')).toBe(false);
    expect(parseServerUrl('http://127.1/v1')?.hostname).toBe('127.0.0.1');
    expect(isRemoteServerUrl('http://127.1/v1')).toBe(false);
  });

  it('asks for localhost patterns together so every loopback spelling is covered', () => {
    expect(originPatternsFor('http://127.0.0.1:8080/v1')).toEqual([
      'http://127.0.0.1/*',
      'http://localhost/*',
      'http://[::1]/*',
    ]);
    expect(originPatternsFor('http://127.0.0.8:8080/v1')).toEqual([
      'http://127.0.0.8/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
      'http://[::1]/*',
    ]);
    expect(originPatternsFor('http://192.168.1.5:1234/v1')).toEqual(['http://192.168.1.5/*']);
    expect(primaryOriginPattern('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1/*');
    expect(primaryOriginPattern('http://localhost:1234/v1')).toBe('http://localhost/*');
    expect(primaryOriginPattern('http://127.0.0.8:8080/v1')).toBe('http://127.0.0.8/*');
    expect(serverOriginKey('http://example.test:9/v1')).toBe('http://example.test:9');
    expect(serverOriginKey('http://example.test:9/v1')).not.toBe(
      serverOriginKey('http://other.test:9/v1'),
    );
  });
});

describe('local server completions', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('sends the same PFML3 prompt wllama would, with greedy sampling and the same stop tokens', async () => {
    const promptInput = { text: 'Hello.', src: 'en', tgt: 'ja', form: 'polite' as const };
    const prompt = buildTranslationPrompt(promptInput);

    const wllama = new FakeRuntime(() => 'こんにちは');
    const inBrowser = new InBrowserEngine(wllama);
    await collectChunks(inBrowser.translate([{ id: 'a', text: 'Hello.' }], options()));
    expect(wllama.requests).toHaveLength(1);
    expect(wllama.requests[0]?.prompt).toBe(prompt);

    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(jsonStop('こんにちは'));
    });
    servers.push(fake);

    const captured: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      captured.push(body);
      return fetch(input, init);
    };

    const runtime = new LocalServerRuntime(() => config(fake.url), fetchImpl);
    const engine = new InBrowserEngine(runtime);
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.prompt).toBe(prompt);
    expect(captured[0]?.prompt).toBe(wllama.requests[0]?.prompt);
    expect(captured[0]?.temperature).toBe(0);
    expect(captured[0]?.stop).toEqual([...TRANSLATION_STOP_TOKENS]);
    expect(captured[0]?.stream).toBe(true);
    expect(captured[0]?.max_tokens).toBe(wllama.requests[0]?.maxTokens);
    expect('top_p' in (captured[0] ?? {})).toBe(false);
    expect(fake.recorded[0]?.body?.prompt).toBe(prompt);
    expect(chunks.some((chunk) => chunk.final === 'こんにちは')).toBe(true);
  });

  it('runs several local-server completions at once instead of waiting for a WebGPU wave', async () => {
    let inflight = 0;
    let peak = 0;
    const fake = await startFakeServer((request, response) => {
      if ((request.url ?? '').includes('/models')) {
        writeModels(response, ['pfnet/plamo-3-translate-0.8b-MLX-4bit']);
        return;
      }
      inflight += 1;
      peak = Math.max(peak, inflight);
      setTimeout(() => {
        inflight -= 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(jsonStop('こんにちは'));
      }, 40);
    });
    servers.push(fake);

    const runtime = new LocalServerRuntime(() => config(fake.url, { parallel: 4 }));
    const engine = new InBrowserEngine(runtime);
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) =>
        collectChunks(engine.translate([{ id, text: `Hello ${id}.` }], options({ priority: 10 }))),
      ),
    );
    expect(peak).toBeGreaterThanOrEqual(4);
  });

  it('sends the same glossary prompt and max_tokens wllama would', async () => {
    const glossary = [{ source: 'Runner', target: 'ランナー機能' }];
    const promptInput = {
      text: 'Open Runner.',
      src: 'en',
      tgt: 'ja',
      form: 'polite' as const,
      glossary,
    };
    const prompt = buildTranslationPrompt(promptInput);
    expect(prompt).toContain(`${PFML3.tag}glossary`);

    const wllama = new FakeRuntime(() => 'ランナー機能を開く。');
    await collectChunks(
      new InBrowserEngine(wllama).translate(
        [{ id: 'a', text: 'Open Runner.' }],
        options({ glossary }),
      ),
    );

    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(jsonStop('ランナー機能を開く。'));
    });
    servers.push(fake);

    const captured: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return fetch(input, init);
    };
    await collectChunks(
      new InBrowserEngine(new LocalServerRuntime(() => config(fake.url), fetchImpl)).translate(
        [{ id: 'a', text: 'Open Runner.' }],
        options({ glossary }),
      ),
    );

    expect(captured[0]?.prompt).toBe(prompt);
    expect(captured[0]?.prompt).toBe(wllama.requests[0]?.prompt);
    expect(captured[0]?.max_tokens).toBe(wllama.requests[0]?.maxTokens);
  });

  it('packs short segments into one prompt the same way wllama does', async () => {
    const segments = [
      { id: 'a', text: 'OK' },
      { id: 'b', text: 'Hi' },
    ];
    const packed = 'OK\nHi';
    const prompt = buildTranslationPrompt({
      text: packed,
      src: 'en',
      tgt: 'ja',
      form: 'polite',
    });

    const wllama = new FakeRuntime(() => 'はい\nこんにちは');
    await collectChunks(new InBrowserEngine(wllama).translate(segments, options()));
    expect(wllama.requests).toHaveLength(1);
    expect(wllama.requests[0]?.prompt).toBe(prompt);

    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(jsonStop('はい\nこんにちは'));
    });
    servers.push(fake);

    const captured: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return fetch(input, init);
    };
    await collectChunks(
      new InBrowserEngine(new LocalServerRuntime(() => config(fake.url), fetchImpl)).translate(
        segments,
        options(),
      ),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.prompt).toBe(prompt);
    expect(captured[0]?.max_tokens).toBe(wllama.requests[0]?.maxTokens);
  });

  it('builds the OpenAI completions body from the runtime request without wrapping chat roles', () => {
    const prompt = buildTranslationPrompt({ text: 'Open the dashboard.', tgt: 'en' });
    const body = completionBody(config('http://127.0.0.1:8080/v1'), {
      prompt,
      maxTokens: 48,
      signal: new AbortController().signal,
      onToken: () => undefined,
    });
    expect(body).toEqual({
      model: 'pfnet/plamo-3-translate-0.8b-MLX-4bit',
      prompt,
      max_tokens: 48,
      temperature: 0,
      stop: [...TRANSLATION_STOP_TOKENS],
      stream: true,
    });
    expect(JSON.stringify(body)).not.toContain('chat');
    expect(JSON.stringify(body)).not.toContain('messages');
  });

  it('refuses a non-loopback URL until the user confirms it', async () => {
    await expect(
      completeOnServer(config('http://192.168.1.20:8080/v1'), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'server-remote-unconfirmed' });
    expect(
      isLocalServerError(
        new EngineError(
          'server-remote-unconfirmed',
          'The local server URL is not on this machine. Confirm the warning in Settings to send text there.',
        ),
      ),
    ).toBe(true);
  });

  it('does not fall back to chat completions when /v1/completions is missing', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ detail: 'Not Found' }));
    });
    servers.push(fake);

    await expect(
      completeOnServer(config(fake.url), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'server-failed',
      message: expect.stringMatching(/Completions API/u),
    });
    expect(fake.recorded.every((entry) => entry.url === '/v1/completions')).toBe(true);
    expect(fake.recorded.some((entry) => entry.url.includes('chat'))).toBe(false);
  });

  it('does not call a 404 generation exception a missing Completions API', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Exception during generation: shape mismatch' }));
    });
    servers.push(fake);

    await expect(
      completeOnServer(config(fake.url), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'server-failed',
      message: expect.stringMatching(/rejected the request/u),
    });
  });

  it('reports an unloaded model from a 404 body as a missing model', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Model not loaded' }));
    });
    servers.push(fake);

    await expect(
      completeOnServer(config(fake.url), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'server-model-missing' });
  });

  it('lists models and flags a missing id', async () => {
    const fake = await startFakeServer((request, response) => {
      handleModelsAndCompletion(response, request);
    });
    servers.push(fake);

    await expect(listServerModels(config(fake.url), new AbortController().signal)).resolves.toEqual(
      [{ id: 'pfnet/plamo-3-translate-0.8b-MLX-4bit' }, { id: 'other' }],
    );
    await expect(testLocalServer(config(fake.url, { model: 'not-loaded' }))).resolves.toMatchObject(
      { ok: false, error: { code: 'server-model-missing' } },
    );
    await expect(testLocalServer(config(fake.url))).resolves.toMatchObject({ ok: true });
  });

  it('treats an empty /v1/models list as unlisted, not as a missing model, and still probes completions', async () => {
    const fake = await startFakeServer((request, response) => {
      if ((request.url ?? '').includes('/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(jsonStop('こんにちは'));
    });
    servers.push(fake);

    await expect(
      testLocalServer(config(fake.url, { model: 'pfnet/plamo-3-translate-0.8b-MLX-4bit' })),
    ).resolves.toMatchObject({ ok: true, models: [] });
    expect(fake.recorded.some((entry) => entry.url === '/v1/completions')).toBe(true);
  });

  it('fails the connection test when Completions is missing after /v1/models succeeds', async () => {
    const fake = await startFakeServer((request, response) => {
      if ((request.url ?? '').includes('/models')) {
        writeModels(response, ['pfnet/plamo-3-translate-0.8b-MLX-4bit']);
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ detail: 'Not Found' }));
    });
    servers.push(fake);

    const result = await testLocalServer(config(fake.url));
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Completions API/u);
    expect(fake.recorded.some((entry) => entry.url === '/v1/completions')).toBe(true);
    expect(fake.recorded.some((entry) => entry.url.includes('chat'))).toBe(false);
  });

  it('reads streamed completion tokens when the last event stops and [DONE] follows', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"text":"Hel"}]}\n\n');
      response.write('data: {"choices":[{"text":"lo","finish_reason":"stop"}]}\n\n');
      response.write('data: [DONE]\n\n');
      response.end();
    });
    servers.push(fake);

    let output = '';
    await completeOnServer(config(fake.url), {
      prompt: 'x',
      maxTokens: 8,
      signal: new AbortController().signal,
      onToken: (text) => {
        output += text;
      },
    });
    expect(output).toBe('Hello');
  });

  it('rejects a stream that ends without [DONE] or finish_reason stop', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"text":"Hel"}]}\n\n');
      response.end();
    });
    servers.push(fake);

    await expect(
      completeOnServer(config(fake.url), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'server-failed',
      message: expect.stringMatching(/ended the stream/u),
    });
  });

  it('rejects a mid-stream disconnect', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"text":"Hel"}]}\n\n');
      response.destroy();
    });
    servers.push(fake);

    await expect(
      completeOnServer(config(fake.url), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toBeInstanceOf(EngineError);
  });

  it('rejects a malformed SSE JSON chunk', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {not json}\n\n');
      response.write('data: [DONE]\n\n');
      response.end();
    });
    servers.push(fake);

    await expect(
      completeOnServer(config(fake.url), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'server-failed',
      message: expect.stringMatching(/malformed/u),
    });
  });

  it('rejects finish_reason length on SSE and JSON, and does not cache the truncated text', async () => {
    const sse = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"text":"Hel","finish_reason":"length"}]}\n\n');
      response.write('data: [DONE]\n\n');
      response.end();
    });
    servers.push(sse);
    const sseTokens: string[] = [];
    await expect(
      completeOnServer(config(sse.url), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: (token) => {
          sseTokens.push(token);
        },
      }),
    ).rejects.toMatchObject({
      code: 'server-failed',
      message: expect.stringMatching(/length/u),
    });
    expect(sseTokens.join('')).toBe('Hel');

    const json = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ text: 'Hel', finish_reason: 'length' }] }));
    });
    servers.push(json);
    await expect(
      completeOnServer(config(json.url), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'server-failed',
      message: expect.stringMatching(/length/u),
    });

    const store = new MemoryTranslationCacheStore();
    const cache = new TranslationCache(store);
    const segments = [{ id: 'a', text: 'Hello.' }];
    const key = buildTranslationCacheKey({
      model: 'local:test',
      tgt: 'ja',
      form: 'polite',
      text: 'Hello.',
      src: 'en',
    });

    const failing = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ text: 'Hel', finish_reason: 'length' }] }));
    });
    servers.push(failing);
    const missEngine = new CachingEngine(
      new InBrowserEngine(new LocalServerRuntime(() => config(failing.url))),
      cache,
      'local:test',
    );
    await expect(collectChunks(missEngine.translate(segments, options()))).rejects.toBeInstanceOf(
      EngineError,
    );
    expect(await cache.get(key)).toBeUndefined();

    const ok = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(jsonStop('こんにちは'));
    });
    servers.push(ok);
    const hitEngine = new CachingEngine(
      new InBrowserEngine(new LocalServerRuntime(() => config(ok.url))),
      cache,
      'local:test',
    );
    const chunks = await collectChunks(hitEngine.translate(segments, options()));
    expect(chunks.some((chunk) => chunk.final === 'こんにちは')).toBe(true);
    expect(await cache.get(key)).toEqual({ text: 'こんにちは', engine: 'plamo' });
  });

  it('rejects a truncated visible translation with an invisible tail on SSE and JSON', async () => {
    const truncated = `これは途中で切れた翻訳です${ISSUE_73_HIDDEN.repeat(4)}`;
    const payload = JSON.stringify({
      choices: [{ text: truncated, finish_reason: 'length' }],
    });

    const sse = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${payload}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
    servers.push(sse);
    const sseTokens: string[] = [];
    await expect(
      completeOnServer(config(sse.url), {
        prompt: 'x',
        maxTokens: 64,
        signal: new AbortController().signal,
        onToken: (token) => {
          sseTokens.push(token);
        },
      }),
    ).rejects.toMatchObject({
      code: 'server-failed',
      message: expect.stringMatching(/length/u),
    });
    expect(sseTokens.join('')).toBe(truncated);

    const json = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(payload);
    });
    servers.push(json);
    await expect(
      completeOnServer(config(json.url), {
        prompt: 'x',
        maxTokens: 64,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'server-failed',
      message: expect.stringMatching(/length/u),
    });

    const store = new MemoryTranslationCacheStore();
    const cache = new TranslationCache(store);
    const segments = [{ id: 'a', text: 'Hello.' }];
    const key = buildTranslationCacheKey({
      model: 'local:test',
      tgt: 'ja',
      form: 'polite',
      text: 'Hello.',
      src: 'en',
    });
    const failing = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(payload);
    });
    servers.push(failing);
    const missEngine = new CachingEngine(
      new InBrowserEngine(new LocalServerRuntime(() => config(failing.url))),
      cache,
      'local:test',
    );
    await expect(collectChunks(missEngine.translate(segments, options()))).rejects.toBeInstanceOf(
      EngineError,
    );
    expect(await cache.get(key)).toBeUndefined();
  });

  it('rejects finish_reason content_filter', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ text: 'x', finish_reason: 'content_filter' }] }));
    });
    servers.push(fake);

    await expect(
      completeOnServer(config(fake.url), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'server-failed',
      message: expect.stringMatching(/content_filter/u),
    });
  });

  it('does not treat text/plain as SSE', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('data: {"choices":[{"text":"Hi","finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    servers.push(fake);

    await expect(
      completeOnServer(config(fake.url), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toBeInstanceOf(EngineError);
  });

  it('times out while the SSE body is still open', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"text":"Hel"}]}\n\n');
    });
    servers.push(fake);

    await expect(
      completeOnServer(config(fake.url, { timeoutMs: 80 }), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'server-timeout' });
  });
});

describe('PlamoSourceEngine', () => {
  it('sends PLaMo pairs to the local server when that source is selected', async () => {
    const local = fakeEngine('plamo', [{ id: 'a', final: 'from-server', engine: 'plamo' }]);
    const inBrowser = fakeEngine('plamo', [{ id: 'a', final: 'from-wllama', engine: 'plamo' }]);
    const engine = new PlamoSourceEngine(inBrowser, local, () => 'local-server');

    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(chunks).toEqual([{ id: 'a', final: 'from-server', engine: 'plamo' }]);
    expect(local.calls).toBe(1);
    expect(inBrowser.calls).toBe(0);
  });

  it('keeps the built-in engine as the default source', async () => {
    const local = fakeEngine('plamo', [{ id: 'a', final: 'from-server', engine: 'plamo' }]);
    const inBrowser = fakeEngine('plamo', [{ id: 'a', final: 'from-wllama', engine: 'plamo' }]);
    const engine = new PlamoSourceEngine(inBrowser, local, () => 'in-browser');

    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(chunks).toEqual([{ id: 'a', final: 'from-wllama', engine: 'plamo' }]);
    expect(inBrowser.calls).toBe(1);
    expect(local.calls).toBe(0);
  });
});
