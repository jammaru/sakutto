export type EngineErrorCode =
  | 'invalid-input'
  | 'unsupported-language'
  | 'model-missing'
  | 'model-integrity'
  | 'model-load-failed'
  | 'gpu-unavailable'
  | 'gpu-lost'
  | 'download-failed'
  | 'storage-insufficient'
  | 'chrome-unavailable'
  | 'chrome-not-ready'
  | 'offscreen-unavailable'
  | 'server-unavailable'
  | 'server-timeout'
  | 'server-model-missing'
  | 'server-failed'
  | 'server-remote-unconfirmed'
  | 'aborted'
  | 'model-changed'
  | 'unknown';

export class EngineError extends Error {
  override readonly name = 'EngineError';
  readonly code: EngineErrorCode;
  readonly retryable: boolean;
  readonly detail?: string;

  constructor(
    code: EngineErrorCode,
    message: string,
    options?: { cause?: unknown; retryable?: boolean; detail?: string },
  ) {
    super(message);
    this.code = code;
    if (options && 'cause' in options) this.cause = options.cause;
    this.retryable = options?.retryable ?? true;
    if (typeof options?.detail === 'string') this.detail = options.detail;
  }
}

export function isEngineError(value: unknown): value is EngineError {
  return value instanceof EngineError;
}

const ENGINE_ERROR_CODES: ReadonlySet<string> = new Set<EngineErrorCode>([
  'invalid-input',
  'unsupported-language',
  'model-missing',
  'model-integrity',
  'model-load-failed',
  'gpu-unavailable',
  'gpu-lost',
  'download-failed',
  'storage-insufficient',
  'chrome-unavailable',
  'chrome-not-ready',
  'offscreen-unavailable',
  'server-unavailable',
  'server-timeout',
  'server-model-missing',
  'server-failed',
  'server-remote-unconfirmed',
  'aborted',
  'model-changed',
  'unknown',
]);

export function isEngineErrorCode(value: unknown): value is EngineErrorCode {
  return typeof value === 'string' && ENGINE_ERROR_CODES.has(value);
}

export function isAbortError(value: unknown): boolean {
  if (value instanceof EngineError) return value.code === 'aborted';
  if (typeof value !== 'object' || value === null) return false;
  const name = 'name' in value && typeof value.name === 'string' ? value.name : '';
  return name === 'AbortError' || name === 'WllamaAbortError';
}

export function abortError(message = 'The operation was aborted.'): EngineError {
  return new EngineError('aborted', message);
}

export function modelChangedError(message = 'The selected model changed.'): EngineError {
  return new EngineError('model-changed', message);
}

export function isModelChangedError(value: unknown): value is EngineError {
  return isEngineError(value) && value.code === 'model-changed';
}

const LOCAL_SERVER_CODES: ReadonlySet<EngineErrorCode> = new Set([
  'server-unavailable',
  'server-timeout',
  'server-model-missing',
  'server-failed',
  'server-remote-unconfirmed',
]);

export function isLocalServerError(value: unknown): value is EngineError {
  return isEngineError(value) && LOCAL_SERVER_CODES.has(value.code);
}

export function toEngineError(value: unknown): EngineError {
  if (isEngineError(value)) return value;
  if (isAbortError(value)) return abortError();
  const message = value instanceof Error ? value.message : String(value);
  return new EngineError('unknown', message, { cause: value });
}
