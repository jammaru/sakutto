import { browser } from 'wxt/browser';
import { DEFAULT_MODEL_ID, type ModelId } from '@/engine/model/catalog';
import { isRecord } from './object';

const QUALITY_SAMPLE_KEY = 'qualitySample';

export interface QualitySample {
  modelId: ModelId;
  milliseconds: number;
  measuredAt: string;
}

export function isQualitySample(value: unknown): value is QualitySample {
  return (
    isRecord(value) &&
    value.modelId === DEFAULT_MODEL_ID &&
    typeof value.milliseconds === 'number' &&
    Number.isFinite(value.milliseconds) &&
    value.milliseconds > 0 &&
    typeof value.measuredAt === 'string'
  );
}

export async function loadQualitySample(): Promise<QualitySample | null> {
  const stored = await browser.storage.local.get(QUALITY_SAMPLE_KEY);
  const value = stored[QUALITY_SAMPLE_KEY];
  return isQualitySample(value) ? value : null;
}

export async function saveQualitySample(sample: QualitySample): Promise<void> {
  await browser.storage.local.set({ [QUALITY_SAMPLE_KEY]: sample });
}
