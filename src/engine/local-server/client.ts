import { abortError, EngineError, isAbortError, isEngineError } from '../errors';
import { buildTranslationPrompt, TRANSLATION_STOP_TOKENS } from '../prompt/pfml3';
import { forwardCompletionToken, type CompletionRequest } from '../in-browser/runtime';
import { plamoPromptTargetLanguage } from '@/shared/languages';
import { isRecord } from '@/shared/object';
import type { Settings } from '@/shared/settings';
import {
  DEFAULT_LOCAL_SERVER_PARALLEL,
  DEFAULT_LOCAL_SERVER_TIMEOUT_MS,
  DEFAULT_LOCAL_SERVER_URL,
  isLoopbackHostname,
  parseServerUrl,
} from './url';

export interface LocalServerConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  allowRemote: boolean;
  parallel: number;
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

/** Short PFML3 probe used by the Settings connection test. */
const CONNECTION_PROBE_TEXT = 'Hi.';
const CONNECTION_PROBE_MAX_TOKENS = 32;

function headers(apiKey: string): Record<string, string> {
  const next: Record<string, string> = { Accept: 'application/json' };
  if (apiKey.length > 0) next.Authorization = `Bearer ${apiKey}`;
  return next;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function mapFetchError(error: unknown, timeout: boolean): EngineError {
  if (isEngineError(error) && error.code !== 'aborted') return error;
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
  if (typeof value.detail === 'string') return value.detail;
  return '';
}

function isMissingModelDetail(detail: string): boolean {
  return /model not (found|loaded)|unknown model|no model|model .+ not (found|loaded)/iu.test(
    detail,
  );
}

function looksLikeMissingCompletions(status: number, body: unknown): boolean {
  if (status !== 404 && status !== 405) return false;
  const detail = readErrorMessage(body);
  if (isMissingModelDetail(detail)) return false;
  if (detail.trim().length === 0) return true;
  return /^(not found|404|cannot post|unknown (endpoint|path|url|route)|no such (url|route|endpoint|path)|invalid url|method not allowed)\b/iu.test(
    detail.trim(),
  );
}

function completionsMissingError(detail: string): EngineError {
  return new EngineError(
    'server-failed',
    'The local translation server has no Completions API. Sakutto sends raw PFML3 to /v1/completions and will not fall back to chat completions.',
    { detail },
  );
}

function serverHttpError(status: number, body: unknown): EngineError {
  const detail = readErrorMessage(body) || `HTTP ${String(status)}`;
  if (isMissingModelDetail(detail)) {
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

function incompleteStreamError(): EngineError {
  return new EngineError(
    'server-failed',
    'The local translation server ended the stream before finishing.',
  );
}

function truncatedCompletionError(reason: string): EngineError {
  return new EngineError(
    'server-failed',
    `The local translation server stopped early (${reason}).`,
    { detail: reason },
  );
}

function malformedEventError(): EngineError {
  return new EngineError(
    'server-failed',
    'The local translation server sent a malformed completion event.',
  );
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

/** `choices[0].finish_reason`, or null when the event has not finished a choice. */
function choiceFinishReason(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const choice = value.choices[0];
  if (!isRecord(choice)) return null;
  if (typeof choice.finish_reason !== 'string' || choice.finish_reason.length === 0) return null;
  return choice.finish_reason;
}

function assertStopReason(reason: string | null, required: boolean): void {
  if (reason === null) {
    if (required) throw incompleteStreamError();
    return;
  }
  if (reason !== 'stop') throw truncatedCompletionError(reason);
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
      'server-remote-unconfirmed',
      'The local server URL is not on this machine. Confirm the warning in Settings to send text there.',
    );
  }
}

interface Deadline {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

function startDeadline(timeoutMs: number, parent: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const onParent = (): void => {
    controller.abort();
  };
  parent.addEventListener('abort', onParent);
  if (parent.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onParent);
    },
  };
}

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return /(?:^|[;\s])text\/event-stream(?:[;\s]|$)/iu.test(contentType);
}

async function fetchServer(
  url: string,
  init: RequestInit,
  deadline: Deadline,
  fetchImpl: LocalServerFetch,
): Promise<Response> {
  throwIfAborted(deadline.signal);
  try {
    return await fetchImpl(url, { ...init, signal: deadline.signal });
  } catch (error) {
    throw mapFetchError(error, deadline.timedOut());
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

async function readSse(
  response: Response,
  request: CompletionRequest,
  deadline: Deadline,
): Promise<void> {
  const body = response.body;
  if (!body) {
    throw new EngineError('server-failed', 'The local translation server returned an empty body.');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | null = null;
  let sawDone = false;

  const consume = (block: string): boolean => {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        sawDone = true;
        return true;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        throw malformedEventError();
      }
      // Forward first so the engine can tell a truncated visible sentence from a
      // format-character collapse before `length` is raised as a hard failure.
      forwardCompletionToken(request.signal, completionText(payload), request.onToken);
      const reason = choiceFinishReason(payload);
      if (reason !== null) {
        finishReason = reason;
        assertStopReason(reason, false);
      }
    }
    return false;
  };

  try {
    for (;;) {
      throwIfAborted(deadline.signal);
      throwIfAborted(request.signal);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw mapFetchError(error, deadline.timedOut());
      }
      if (chunk.done) {
        buffer += decoder.decode();
        if (buffer.trim().length > 0) consume(buffer);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (consume(part)) {
          sawDone = true;
          break;
        }
      }
      if (sawDone) break;
    }
  } catch (error) {
    if (isEngineError(error) && error.code !== 'aborted') throw error;
    throw mapFetchError(error, deadline.timedOut());
  }

  if (finishReason !== 'stop') throw incompleteStreamError();
}

export async function completeOnServer(
  config: LocalServerConfig,
  request: CompletionRequest,
  fetchImpl: LocalServerFetch = fetch,
): Promise<void> {
  const parsed = requireParsed(config);
  guardRemote(config, parsed.hostname);
  const deadline = startDeadline(config.timeoutMs, request.signal);

  try {
    const response = await fetchServer(
      parsed.completionsUrl,
      {
        method: 'POST',
        headers: { ...headers(config.apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(completionBody(config, request)),
      },
      deadline,
      fetchImpl,
    );

    if (!response.ok) {
      const payload = await readJson(response);
      const detail = readErrorMessage(payload) || `HTTP ${String(response.status)}`;
      if (looksLikeMissingCompletions(response.status, payload)) {
        throw completionsMissingError(detail);
      }
      throw serverHttpError(response.status, payload);
    }

    if (isEventStream(response)) {
      await readSse(response, request, deadline);
      return;
    }

    const payload = await readJson(response);
    const text = completionText(payload);
    if (text.length === 0 && payload !== null) {
      assertStopReason(choiceFinishReason(payload), true);
      throw new EngineError(
        'server-failed',
        'The local translation server returned no completion text.',
      );
    }
    // Forward first so the engine can tell a truncated visible sentence from a
    // format-character collapse before `length` is raised as a hard failure.
    forwardCompletionToken(request.signal, text, request.onToken);
    assertStopReason(choiceFinishReason(payload), true);
  } catch (error) {
    if (isEngineError(error) && error.code !== 'aborted') throw error;
    throw mapFetchError(error, deadline.timedOut());
  } finally {
    deadline.dispose();
  }
}

export async function listServerModels(
  config: LocalServerConfig,
  signal: AbortSignal,
  fetchImpl: LocalServerFetch = fetch,
): Promise<LocalServerModel[]> {
  const parsed = requireParsed(config);
  guardRemote(config, parsed.hostname);
  const deadline = startDeadline(config.timeoutMs, signal);
  try {
    const response = await fetchServer(
      parsed.modelsUrl,
      { method: 'GET', headers: headers(config.apiKey) },
      deadline,
      fetchImpl,
    );
    const payload = await readJson(response);
    if (!response.ok) throw serverHttpError(response.status, payload);
    return parseModelList(payload);
  } catch (error) {
    if (isEngineError(error) && error.code !== 'aborted') throw error;
    throw mapFetchError(error, deadline.timedOut());
  } finally {
    deadline.dispose();
  }
}

function connectionProbeRequest(signal: AbortSignal): CompletionRequest {
  return {
    prompt: buildTranslationPrompt({
      text: CONNECTION_PROBE_TEXT,
      src: 'en',
      tgt: plamoPromptTargetLanguage('ja'),
      form: 'polite',
    }),
    maxTokens: CONNECTION_PROBE_MAX_TOKENS,
    signal,
    onToken: () => undefined,
  };
}

export async function testLocalServer(
  config: LocalServerConfig,
  fetchImpl: LocalServerFetch = fetch,
): Promise<ConnectionTestResult> {
  let models: LocalServerModel[] = [];
  try {
    models = await listServerModels(config, new AbortController().signal, fetchImpl);
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
    await completeOnServer(config, connectionProbeRequest(new AbortController().signal), fetchImpl);
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
    return { ok: false, models, error: mapped };
  }
}

export function localServerConfigFromSettings(stored: Settings | null): LocalServerConfig {
  return {
    baseUrl: stored?.localServerUrl ?? DEFAULT_LOCAL_SERVER_URL,
    model: stored?.localServerModel ?? '',
    apiKey: stored?.localServerApiKey ?? '',
    timeoutMs: stored?.localServerTimeoutMs ?? DEFAULT_LOCAL_SERVER_TIMEOUT_MS,
    allowRemote: stored?.localServerAllowRemote === true,
    parallel: stored?.localServerParallel ?? DEFAULT_LOCAL_SERVER_PARALLEL,
  };
}
