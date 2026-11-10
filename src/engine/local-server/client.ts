import { abortError, EngineError, isAbortError } from '../errors';
import { TRANSLATION_STOP_TOKENS } from '../prompt/pfml3';
import { forwardCompletionToken, type CompletionRequest } from '../in-browser/runtime';
import { isRecord } from '@/shared/object';
import { isLoopbackHostname, parseServerUrl } from './url';

export interface LocalServerConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  allowRemote: boolean;
}

export interface LocalServerModel {
  id: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  models: LocalServerModel[];
  error?: EngineError;
}

export type LocalServerFetch = typeof fetch;

function headers(apiKey: string): Record<string, string> {
  const next: Record<string, string> = { Accept: 'application/json' };
  if (apiKey.length > 0) next.Authorization = `Bearer ${apiKey}`;
  return next;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function mapFetchError(error: unknown, timeout: boolean): EngineError {
  if (isAbortError(error) || (error instanceof DOMException && error.name === 'AbortError')) {
    if (timeout) {
      return new EngineError('server-timeout', 'The local translation server timed out.');
    }
    return abortError();
  }
  const message = error instanceof Error ? error.message : String(error);
  return new EngineError(
    'server-unavailable',
    'The local translation server could not be reached.',
    {
      cause: error,
      detail: message,
    },
  );
}

function readErrorMessage(value: unknown): string {
  if (!isRecord(value)) return '';
  if (typeof value.error === 'string') return value.error;
  if (isRecord(value.error) && typeof value.error.message === 'string') return value.error.message;
  if (typeof value.message === 'string') return value.message;
  return '';
}

function serverHttpError(status: number, body: unknown): EngineError {
  const detail = readErrorMessage(body) || `HTTP ${String(status)}`;
  const missing =
    status === 404 || /model not (found|loaded)|unknown model|no model/iu.test(detail);
  if (missing) {
    return new EngineError(
      'server-model-missing',
      'The local translation server has no matching model.',
      {
        detail,
      },
    );
  }
  if (status === 408 || status === 504) {
    return new EngineError('server-timeout', 'The local translation server timed out.', { detail });
  }
  return new EngineError('server-failed', 'The local translation server rejected the request.', {
    detail,
  });
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function completionText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices)) return '';
  const choice = value.choices[0];
  if (!isRecord(choice)) return '';
  if (typeof choice.text === 'string') return choice.text;
  if (isRecord(choice.delta)) {
    if (typeof choice.delta.content === 'string') return choice.delta.content;
    if (typeof choice.delta.text === 'string') return choice.delta.text;
  }
  if (isRecord(choice.message) && typeof choice.message.content === 'string') {
    return choice.message.content;
  }
  return '';
}

function parseModelList(value: unknown): LocalServerModel[] {
  const rows = isRecord(value) && Array.isArray(value.data) ? value.data : [];
  const models: LocalServerModel[] = [];
  for (const row of rows) {
    if (isRecord(row) && typeof row.id === 'string' && row.id.trim().length > 0) {
      models.push({ id: row.id.trim() });
    }
  }
  return models;
}

function requireParsed(config: LocalServerConfig) {
  const parsed = parseServerUrl(config.baseUrl);
  if (!parsed) {
    throw new EngineError('server-failed', 'The local server URL is not a valid http(s) address.');
  }
  if (!config.allowRemote && !parsed.hostname) {
    throw new EngineError('server-failed', 'The local server URL is not a valid http(s) address.');
  }
  return parsed;
}

function guardRemote(config: LocalServerConfig, hostname: string): void {
  if (!isLoopbackHostname(hostname) && !config.allowRemote) {
    throw new EngineError(
      'server-failed',
      'The local server URL is not on this machine. Confirm the warning in Settings to send text there.',
    );
  }
}

async function fetchServer(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal,
  fetchImpl: LocalServerFetch,
): Promise<Response> {
  throwIfAborted(signal);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = (): void => controller.abort();
  signal.addEventListener('abort', forwardAbort, { once: true });

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw mapFetchError(error, timedOut);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forwardAbort);
  }
}

export function completionBody(
  config: LocalServerConfig,
  request: CompletionRequest,
): Record<string, unknown> {
  return {
    ...(config.model.length > 0 ? { model: config.model } : {}),
    prompt: request.prompt,
    max_tokens: request.maxTokens,
    temperature: 0,
    stop: [...TRANSLATION_STOP_TOKENS],
    stream: true,
  };
}

async function readSse(response: Response, request: CompletionRequest): Promise<void> {
  const body = response.body;
  if (!body) {
    throw new EngineError('server-failed', 'The local translation server returned an empty body.');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = (block: string): boolean => {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return true;
      try {
        forwardCompletionToken(
          request.signal,
          completionText(JSON.parse(data) as unknown),
          request.onToken,
        );
      } catch {
        // Keep reading; a broken event is not fatal if later events arrive.
      }
    }
    return false;
  };

  for (;;) {
    throwIfAborted(request.signal);
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      consume(buffer);
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (consume(part)) return;
    }
  }
}

export async function completeOnServer(
  config: LocalServerConfig,
  request: CompletionRequest,
  fetchImpl: LocalServerFetch = fetch,
): Promise<void> {
  const parsed = requireParsed(config);
  guardRemote(config, parsed.hostname);

  const response = await fetchServer(
    parsed.completionsUrl,
    {
      method: 'POST',
      headers: { ...headers(config.apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(completionBody(config, request)),
    },
    config.timeoutMs,
    request.signal,
    fetchImpl,
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new EngineError(
        'server-failed',
        'The local translation server has no Completions API. Sakutto sends raw PFML3 to /v1/completions and will not fall back to chat completions.',
        { detail: `HTTP ${String(response.status)}` },
      );
    }
    throw serverHttpError(response.status, await readJson(response));
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream') || contentType.includes('text/plain')) {
    await readSse(response, request);
    return;
  }

  const payload = await readJson(response);
  const text = completionText(payload);
  if (text.length === 0 && payload !== null) {
    throw new EngineError(
      'server-failed',
      'The local translation server returned no completion text.',
    );
  }
  forwardCompletionToken(request.signal, text, request.onToken);
}

export async function listServerModels(
  config: LocalServerConfig,
  signal: AbortSignal,
  fetchImpl: LocalServerFetch = fetch,
): Promise<LocalServerModel[]> {
  const parsed = requireParsed(config);
  guardRemote(config, parsed.hostname);
  const response = await fetchServer(
    parsed.modelsUrl,
    { method: 'GET', headers: headers(config.apiKey) },
    config.timeoutMs,
    signal,
    fetchImpl,
  );
  const payload = await readJson(response);
  if (!response.ok) throw serverHttpError(response.status, payload);
  return parseModelList(payload);
}

export async function testLocalServer(
  config: LocalServerConfig,
  fetchImpl: LocalServerFetch = fetch,
): Promise<ConnectionTestResult> {
  try {
    const models = await listServerModels(config, new AbortController().signal, fetchImpl);
    if (
      config.model.length > 0 &&
      models.length > 0 &&
      !models.some((model) => model.id === config.model)
    ) {
      return {
        ok: false,
        models,
        error: new EngineError(
          'server-model-missing',
          'The local translation server has no matching model.',
        ),
      };
    }
    return { ok: true, models };
  } catch (error) {
    const mapped =
      error instanceof EngineError
        ? error
        : new EngineError(
            'server-unavailable',
            'The local translation server could not be reached.',
            {
              cause: error,
            },
          );
    return { ok: false, models: [], error: mapped };
  }
}
