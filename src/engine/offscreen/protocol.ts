import { EngineError, isEngineErrorCode, type EngineErrorCode } from '../errors';
import { isModelId, type ModelId } from '../model/catalog';
import { isTranslationChunk } from '../types';
import type {
  Formality,
  GlossaryEntry,
  TranslateOptions,
  TranslateSegment,
  TranslationChunk,
} from '../types';
import { isModelStatus, type ModelStatus } from '../../shared/engine-status';
import { isTargetLanguage } from '../../shared/languages';
import { isTierPreference, type TierPreference } from '../../shared/settings';

export const ENGINE_HOST_PORT = 'sakutto:engine-host';
export const TRANSLATION_PORT = 'sakutto:translate';

export interface SerializedTranslateOptions {
  src?: string;
  tgt: string;
  form: Formality;
  glossary?: GlossaryEntry[];
  context?: string;
  priority: number;
  eager?: boolean;
  draft?: boolean;
  preview?: boolean;
}

export function serializeTranslateOptions(options: TranslateOptions): SerializedTranslateOptions {
  return {
    tgt: options.tgt,
    form: options.form,
    priority: options.priority,
    ...(options.src !== undefined ? { src: options.src } : {}),
    ...(options.glossary && options.glossary.length > 0
      ? { glossary: options.glossary.map((entry) => ({ ...entry })) }
      : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
    ...(options.eager ? { eager: true } : {}),
    ...(options.draft ? { draft: true } : {}),
    ...(options.preview ? { preview: true } : {}),
  };
}

export function deserializeTranslateOptions(
  serialized: SerializedTranslateOptions,
  signal: AbortSignal,
): TranslateOptions {
  return {
    tgt: serialized.tgt,
    form: serialized.form,
    priority: serialized.priority,
    signal,
    ...(serialized.src !== undefined ? { src: serialized.src } : {}),
    ...(serialized.glossary ? { glossary: serialized.glossary } : {}),
    ...(serialized.context !== undefined ? { context: serialized.context } : {}),
    ...(serialized.eager ? { eager: true } : {}),
    ...(serialized.draft ? { draft: true } : {}),
    ...(serialized.preview ? { preview: true } : {}),
  };
}

export interface EngineErrorPayload {
  code: EngineErrorCode;
  message: string;
}

export function errorPayload(error: unknown): EngineErrorPayload {
  if (error instanceof EngineError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'unknown', message: error.message };
  return { code: 'unknown', message: String(error) };
}

export function errorFromPayload(payload: EngineErrorPayload): EngineError {
  return new EngineError(payload.code, payload.message);
}

export interface TranslateRequest {
  type: 'translate';
  requestId: string;
  segments: TranslateSegment[];
  options: SerializedTranslateOptions;
}

export interface CancelRequest {
  type: 'cancel';
  requestId: string;
}

export interface StatusRequest {
  type: 'status';
  requestId: string;
}

export interface PingRequest {
  type: 'ping';
  requestId: string;
}

export interface ModelDownloadRequest {
  type: 'model-download';
  requestId: string;
  modelId: ModelId;
}

export interface ModelCancelRequest {
  type: 'model-cancel';
  requestId: string;
}

export interface ModelDeleteRequest {
  type: 'model-delete';
  requestId: string;
  modelId: ModelId;
}

export interface ModelUseRequest {
  type: 'model-use';
  requestId: string;
  modelId: ModelId;
}

export interface ModelWarmRequest {
  type: 'model-warm';
  requestId: string;
}

export interface ModelStatusRequest {
  type: 'model-status';
  requestId: string;
  modelId: ModelId;
}

export interface CacheClearRequest {
  type: 'cache-clear';
  requestId: string;
}

export interface TierSetRequest {
  type: 'tier-set';
  requestId: string;
  tier: TierPreference;
}

export interface BenchmarkRequest {
  type: 'benchmark';
  requestId: string;
}

export type EngineHostRequest =
  | TranslateRequest
  | CancelRequest
  | StatusRequest
  | PingRequest
  | ModelDownloadRequest
  | ModelCancelRequest
  | ModelDeleteRequest
  | ModelUseRequest
  | ModelWarmRequest
  | ModelStatusRequest
  | CacheClearRequest
  | TierSetRequest
  | BenchmarkRequest;

export interface ChunkEvent {
  type: 'chunk';
  requestId: string;
  chunk: TranslationChunk;
}

export interface DoneEvent {
  type: 'done';
  requestId: string;
}

export interface ErrorEvent {
  type: 'error';
  requestId: string;
  error: EngineErrorPayload;
}

export interface ModelProgressEvent {
  type: 'model-progress';
  requestId: string;
  status: ModelStatus;
}

export interface ResponseEvent {
  type: 'response';
  requestId: string;
  ok: true;
  value: unknown;
}

export interface ResponseErrorEvent {
  type: 'response';
  requestId: string;
  ok: false;
  error: EngineErrorPayload;
}

export type EngineHostMessage =
  ChunkEvent | DoneEvent | ErrorEvent | ModelProgressEvent | ResponseEvent | ResponseErrorEvent;

export interface TranslationStartRequest {
  type: 'start';
  requestId: string;
  segments: TranslateSegment[];
  options: SerializedTranslateOptions;
}

export interface TranslationCancelRequest {
  type: 'cancel';
  requestId: string;
}

export interface TranslationChunkEvent {
  type: 'chunk';
  requestId: string;
  chunk: TranslationChunk;
}

export interface TranslationDoneEvent {
  type: 'done';
  requestId: string;
}

export interface TranslationErrorEvent {
  type: 'error';
  requestId: string;
  error: EngineErrorPayload;
}

export type TranslationClientMessage = TranslationStartRequest | TranslationCancelRequest;

export type TranslationServerMessage =
  TranslationChunkEvent | TranslationDoneEvent | TranslationErrorEvent;

const MAX_SEGMENTS = 2000;
const MAX_SEGMENT_ID = 200;
const MAX_SEGMENT_TEXT = 20_000;
const MAX_CONTEXT_TEXT = 20_000;
const MAX_GLOSSARY_ENTRIES = 1000;
const MAX_GLOSSARY_TEXT = 4096;
const MAX_LANGUAGE_TAG = 35;
const MAX_PRIORITY = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function isGlossary(value: unknown): value is GlossaryEntry[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_GLOSSARY_ENTRIES &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        isBoundedText(entry.source, MAX_GLOSSARY_TEXT) &&
        isBoundedText(entry.target, MAX_GLOSSARY_TEXT),
    )
  );
}

export function isSerializedTranslateOptions(value: unknown): value is SerializedTranslateOptions {
  if (!isRecord(value)) return false;
  if (!isTargetLanguage(value.tgt)) return false;
  if (value.form !== 'polite' && value.form !== 'plain') return false;
  if (typeof value.priority !== 'number' || !Number.isFinite(value.priority)) return false;
  if (value.priority < -MAX_PRIORITY || value.priority > MAX_PRIORITY) return false;
  if (value.src !== undefined && !isBoundedText(value.src, MAX_LANGUAGE_TAG)) return false;
  if (value.context !== undefined && !isBoundedText(value.context, MAX_CONTEXT_TEXT)) return false;
  if (value.glossary !== undefined && !isGlossary(value.glossary)) return false;
  if (value.eager !== undefined && typeof value.eager !== 'boolean') return false;
  if (value.draft !== undefined && typeof value.draft !== 'boolean') return false;
  if (value.preview !== undefined && typeof value.preview !== 'boolean') return false;
  return true;
}

function isRequestId(value: Record<string, unknown>): boolean {
  return typeof value.requestId === 'string' && value.requestId.length > 0;
}

function isSegments(value: unknown): value is TranslateSegment[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SEGMENTS &&
    value.every(
      (segment) =>
        isRecord(segment) &&
        isBoundedText(segment.id, MAX_SEGMENT_ID) &&
        segment.id.length > 0 &&
        isBoundedText(segment.text, MAX_SEGMENT_TEXT),
    )
  );
}

export function isEngineHostRequest(value: unknown): value is EngineHostRequest {
  if (!isRecord(value) || !isRequestId(value)) return false;

  switch (value.type) {
    case 'translate':
      return isSegments(value.segments) && isSerializedTranslateOptions(value.options);
    case 'status':
    case 'ping':
    case 'cancel':
    case 'model-cancel':
    case 'model-warm':
      return true;
    case 'model-download':
    case 'model-delete':
    case 'model-use':
    case 'model-status':
      return isModelId(value.modelId);
    case 'cache-clear':
    case 'benchmark':
      return true;
    case 'tier-set':
      return isTierPreference(value.tier);
    default:
      return false;
  }
}

export function isTranslationStartRequest(value: unknown): value is TranslationStartRequest {
  return (
    isRecord(value) &&
    value.type === 'start' &&
    isRequestId(value) &&
    isSegments(value.segments) &&
    isSerializedTranslateOptions(value.options)
  );
}

export function isTranslationCancelRequest(value: unknown): value is TranslationCancelRequest {
  return isRecord(value) && value.type === 'cancel' && isRequestId(value);
}

function isErrorPayload(value: unknown): value is EngineErrorPayload {
  return isRecord(value) && isEngineErrorCode(value.code) && typeof value.message === 'string';
}

export function isEngineHostMessage(value: unknown): value is EngineHostMessage {
  if (!isRecord(value) || !isRequestId(value)) return false;

  switch (value.type) {
    case 'chunk':
      return isTranslationChunk(value.chunk);
    case 'done':
      return true;
    case 'error':
      return isErrorPayload(value.error);
    case 'model-progress':
      return isModelStatus(value.status);
    case 'response':
      return (
        typeof value.ok === 'boolean' && (value.ok ? 'value' in value : isErrorPayload(value.error))
      );
    default:
      return false;
  }
}

export function isTranslationServerMessage(value: unknown): value is TranslationServerMessage {
  if (!isRecord(value) || !isRequestId(value)) return false;

  switch (value.type) {
    case 'chunk':
      return isTranslationChunk(value.chunk);
    case 'done':
      return true;
    case 'error':
      return isErrorPayload(value.error);
    default:
      return false;
  }
}
