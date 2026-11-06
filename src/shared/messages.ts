import { browser } from 'wxt/browser';
import { isModelId, type ModelId } from '@/engine/model/catalog';
import {
  isEngineStatus,
  isModelStatus,
  type EngineStatus,
  type ModelStatus,
} from '@/shared/engine-status';
import { isEngineCapabilities, type EngineCapabilities } from './capabilities';
import type { EngineKind } from '@/engine/types';
import { isSiteHost, type SiteAuto } from '@/dom/sites';
import type { QualitySample } from './quality';
import { isQualitySample } from './quality';
import type { DisplayMode, TierPreference } from './settings';
import { isTierPreference } from './settings';
import { isRecord } from './object';

export interface PageInfo {
  lang: string;
  translatableBlocks: number;
}

export interface PageInfoRequest {
  type: 'page:info';
}

export type PageCommandName = 'toggle' | 'restore' | 'bilingual' | 'selection';

export interface PageCommandRequest {
  type: 'page:command';
  command: PageCommandName;
}

export interface PageStateRequest {
  type: 'page:state';
}

export interface PageViewState {
  active: boolean;
  display: DisplayMode;
  engine: EngineKind | null;
  pending: number;
  done: number;
  total: number;
  host: string;
  auto: SiteAuto;
  targetLanguage: string;
  pageLanguage: string | null;
  targetAdjusted: boolean;
  sameLanguage: boolean;
  tokensPerSecond: number | null;
  segmentsPerSecond: number | null;
  /** Visible prose that stayed in the source language because no segment could be built. */
  skipped: number;
}

const PAGE_COMMANDS: ReadonlySet<string> = new Set<PageCommandName>([
  'toggle',
  'restore',
  'bilingual',
  'selection',
]);

export interface EngineCapabilitiesRequest {
  type: 'engine:capabilities';
}

export interface EngineProbeRequest {
  type: 'engine:probe';
}

export interface EngineProbeResponse {
  source: 'offscreen';
  capabilities: EngineCapabilities;
}

export interface EngineStatusRequest {
  type: 'engine:status';
}

export interface EngineWarmRequest {
  type: 'engine:warm';
}

export interface SiteGrantRequest {
  type: 'site:grant';
  host: string;
}

export interface ShortcutQuery {
  type: 'commands:shortcuts';
}

export interface ShortcutSnapshot {
  selection: string | null;
}

export interface ModelDownloadRequest {
  type: 'model:download';
  modelId: ModelId;
}

export interface ModelCancelRequest {
  type: 'model:cancel';
  modelId: ModelId;
}

export interface ModelDeleteRequest {
  type: 'model:delete';
  modelId: ModelId;
}

export interface ModelUseRequest {
  type: 'model:use';
  modelId: ModelId;
}

export interface ModelProgressMessage {
  type: 'model:progress';
  status: ModelStatus;
}

export interface ModelInspectRequest {
  type: 'model:inspect';
  modelId: ModelId;
}

export interface CacheClearRequest {
  type: 'cache:clear';
}

export interface EngineTierRequest {
  type: 'engine:tier';
  tier: TierPreference;
}

export interface QualitySampleRequest {
  type: 'quality:sample';
}

export function isPageInfoRequest(value: unknown): value is PageInfoRequest {
  return isRecord(value) && value.type === 'page:info';
}

export function isPageCommandRequest(value: unknown): value is PageCommandRequest {
  return (
    isRecord(value) &&
    value.type === 'page:command' &&
    typeof value.command === 'string' &&
    PAGE_COMMANDS.has(value.command)
  );
}

export function isPageStateRequest(value: unknown): value is PageStateRequest {
  return isRecord(value) && value.type === 'page:state';
}

export function isPageViewState(value: unknown): value is PageViewState {
  return (
    isRecord(value) &&
    typeof value.active === 'boolean' &&
    (value.display === 'replace' || value.display === 'bilingual') &&
    (value.engine === null || value.engine === 'plamo' || value.engine === 'chrome') &&
    typeof value.pending === 'number' &&
    typeof value.done === 'number' &&
    typeof value.total === 'number' &&
    typeof value.host === 'string' &&
    (value.auto === 'ask' || value.auto === 'always' || value.auto === 'never') &&
    typeof value.targetLanguage === 'string' &&
    (value.pageLanguage === null || typeof value.pageLanguage === 'string') &&
    typeof value.targetAdjusted === 'boolean' &&
    typeof value.sameLanguage === 'boolean' &&
    (value.tokensPerSecond === null || typeof value.tokensPerSecond === 'number') &&
    (value.segmentsPerSecond === null || typeof value.segmentsPerSecond === 'number') &&
    (value.skipped === undefined || (typeof value.skipped === 'number' && value.skipped >= 0))
  );
}

export function isEngineCapabilitiesRequest(value: unknown): value is EngineCapabilitiesRequest {
  return isRecord(value) && value.type === 'engine:capabilities';
}

export function isEngineProbeRequest(value: unknown): value is EngineProbeRequest {
  return isRecord(value) && value.type === 'engine:probe';
}

export function isEngineStatusRequest(value: unknown): value is EngineStatusRequest {
  return isRecord(value) && value.type === 'engine:status';
}

export function isEngineWarmRequest(value: unknown): value is EngineWarmRequest {
  return isRecord(value) && value.type === 'engine:warm';
}

export function isSiteGrantRequest(value: unknown): value is SiteGrantRequest {
  return isRecord(value) && value.type === 'site:grant' && isSiteHost(value.host);
}

export function isShortcutQuery(value: unknown): value is ShortcutQuery {
  return isRecord(value) && value.type === 'commands:shortcuts';
}

export function isModelDownloadRequest(value: unknown): value is ModelDownloadRequest {
  return isRecord(value) && value.type === 'model:download' && isModelId(value.modelId);
}

export function isModelCancelRequest(value: unknown): value is ModelCancelRequest {
  return isRecord(value) && value.type === 'model:cancel' && isModelId(value.modelId);
}

export function isModelDeleteRequest(value: unknown): value is ModelDeleteRequest {
  return isRecord(value) && value.type === 'model:delete' && isModelId(value.modelId);
}

export function isModelUseRequest(value: unknown): value is ModelUseRequest {
  return isRecord(value) && value.type === 'model:use' && isModelId(value.modelId);
}

export function isModelProgressMessage(value: unknown): value is ModelProgressMessage {
  return isRecord(value) && value.type === 'model:progress' && isModelStatus(value.status);
}

export function isModelInspectRequest(value: unknown): value is ModelInspectRequest {
  return isRecord(value) && value.type === 'model:inspect' && isModelId(value.modelId);
}

export function isCacheClearRequest(value: unknown): value is CacheClearRequest {
  return isRecord(value) && value.type === 'cache:clear';
}

export function isEngineTierRequest(value: unknown): value is EngineTierRequest {
  return isRecord(value) && value.type === 'engine:tier' && isTierPreference(value.tier);
}

export function isQualitySampleRequest(value: unknown): value is QualitySampleRequest {
  return isRecord(value) && value.type === 'quality:sample';
}

export function isPageInfo(value: unknown): value is PageInfo {
  return (
    isRecord(value) &&
    typeof value.lang === 'string' &&
    typeof value.translatableBlocks === 'number'
  );
}

export function isEngineProbeResponse(value: unknown): value is EngineProbeResponse {
  return (
    isRecord(value) && value.source === 'offscreen' && isEngineCapabilities(value.capabilities)
  );
}

export async function requestPageState(tabId: number): Promise<PageViewState | null> {
  try {
    const response: unknown = await browser.tabs.sendMessage(tabId, {
      type: 'page:state',
    } satisfies PageStateRequest);
    return isPageViewState(response) ? response : null;
  } catch {
    return null;
  }
}

export async function requestPageCommand(
  tabId: number,
  command: PageCommandName,
): Promise<PageViewState | null> {
  try {
    const response: unknown = await browser.tabs.sendMessage(tabId, {
      type: 'page:command',
      command,
    } satisfies PageCommandRequest);
    return isPageViewState(response) ? response : null;
  } catch {
    return null;
  }
}

export async function requestPageInfo(tabId: number): Promise<PageInfo | null> {
  try {
    const response: unknown = await browser.tabs.sendMessage(tabId, {
      type: 'page:info',
    } satisfies PageInfoRequest);
    return isPageInfo(response) ? response : null;
  } catch {
    return null;
  }
}

export async function requestEngineProbe(): Promise<EngineCapabilities | null> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: 'engine:probe',
    } satisfies EngineProbeRequest);
    return isEngineProbeResponse(response) ? response.capabilities : null;
  } catch {
    return null;
  }
}

export async function requestEngineCapabilities(): Promise<EngineCapabilities | null> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: 'engine:capabilities',
    } satisfies EngineCapabilitiesRequest);
    return isEngineCapabilities(response) ? response : null;
  } catch {
    return null;
  }
}

export async function requestEngineStatus(): Promise<EngineStatus | null> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: 'engine:status',
    } satisfies EngineStatusRequest);
    return isEngineStatus(response) ? response : null;
  } catch {
    return null;
  }
}

export async function requestEngineWarm(): Promise<boolean> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: 'engine:warm',
    } satisfies EngineWarmRequest);
    return response === true;
  } catch {
    return false;
  }
}

export async function requestModelDownload(modelId: ModelId): Promise<boolean> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: 'model:download',
      modelId,
    } satisfies ModelDownloadRequest);
    return response === true;
  } catch {
    return false;
  }
}

export async function requestModelCancel(modelId: ModelId): Promise<void> {
  try {
    await browser.runtime.sendMessage({
      type: 'model:cancel',
      modelId,
    } satisfies ModelCancelRequest);
  } catch {
    // Cancelling is best effort.
  }
}

export async function requestModelDelete(modelId: ModelId): Promise<ModelStatus | null> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: 'model:delete',
      modelId,
    } satisfies ModelDeleteRequest);
    return isModelStatus(response) ? response : null;
  } catch {
    return null;
  }
}

export async function requestModelInspect(modelId: ModelId): Promise<ModelStatus | null> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: 'model:inspect',
      modelId,
    } satisfies ModelInspectRequest);
    return isModelStatus(response) ? response : null;
  } catch {
    return null;
  }
}

export async function requestCacheClear(): Promise<boolean> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: 'cache:clear',
    } satisfies CacheClearRequest);
    return response === true;
  } catch {
    return false;
  }
}

export async function requestEngineTier(tier: TierPreference): Promise<boolean> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: 'engine:tier',
      tier,
    } satisfies EngineTierRequest);
    return response === true;
  } catch {
    return false;
  }
}

export async function requestQualitySample(): Promise<QualitySample | null> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: 'quality:sample',
    } satisfies QualitySampleRequest);
    return isQualitySample(response) ? response : null;
  } catch {
    return null;
  }
}

export async function requestModelUse(modelId: ModelId): Promise<ModelStatus | null> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: 'model:use',
      modelId,
    } satisfies ModelUseRequest);
    return isModelStatus(response) ? response : null;
  } catch {
    return null;
  }
}
