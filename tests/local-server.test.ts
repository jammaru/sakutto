import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
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
  DEFAULT_LOCAL_SERVER_URL,
  isLoopbackHostname,
  isRemoteServerUrl,
  normalizeServerUrl,
  originPatternsFor,
  parseServerUrl,
  primaryOriginPattern,
} from '@/engine/local-server/url';
import { buildTranslationPrompt, TRANSLATION_STOP_TOKENS } from '@/engine/prompt/pfml3';
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

describe('local server URL', () => {
  it('normalises a host without /v1 and keeps a completions path off the stored URL', () => {
    expect(normalizeServerUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/v1');
    expect(normalizeServerUrl('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080/v1');
    expect(parseServerUrl('http://localhost:1234/v1')?.completionsUrl).toBe(
      'http://localhost:1234/v1/completions',
    );
    expect(normalizeServerUrl('not a url')).toBe(DEFAULT_LOCAL_SERVER_URL);
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

  it('asks for localhost patterns together so every loopback spelling is covered', () => {
    expect(originPatternsFor('http://127.0.0.1:8080/v1')).toEqual([
      'http://127.0.0.1/*',
      'http://localhost/*',
      'http://[::1]/*',
    ]);
    expect(originPatternsFor('http://192.168.1.5:1234/v1')).toEqual(['http://192.168.1.5/*']);
    expect(primaryOriginPattern('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1/*');
    expect(primaryOriginPattern('http://localhost:1234/v1')).toBe('http://localhost/*');
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

    const fake = await startFakeServer((_request, response, recorded) => {
      expect(recorded.url).toBe('/v1/completions');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ text: 'こんにちは' }] }));
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
    expect('top_p' in (captured[0] ?? {})).toBe(false);
    expect(fake.recorded[0]?.body?.prompt).toBe(prompt);
    expect(chunks.some((chunk) => chunk.final === 'こんにちは')).toBe(true);
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
      completeOnServer(config('http://example.test:1234/v1'), {
        prompt: 'x',
        maxTokens: 8,
        signal: new AbortController().signal,
        onToken: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'server-failed' });
    expect(
      isLocalServerError(
        new EngineError('server-unavailable', 'The local translation server could not be reached.'),
      ),
    ).toBe(true);
  });

  it('does not fall back to chat completions when /v1/completions is missing', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'nope' }));
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
  });

  it('lists models and flags a missing id', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          data: [{ id: 'pfnet/plamo-3-translate-0.8b-MLX-4bit' }, { id: 'other' }],
        }),
      );
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

  it('reads streamed completion tokens', async () => {
    const fake = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"text":"Hel"}]}\n\n');
      response.write('data: {"choices":[{"text":"lo"}]}\n\n');
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
