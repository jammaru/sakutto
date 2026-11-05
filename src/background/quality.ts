import type { EngineClient } from '@/background/engine-client';
import { DEFAULT_MODEL_ID } from '@/engine/model/catalog';
import { loadQualitySample, saveQualitySample, type QualitySample } from '@/shared/quality';

let pending: Promise<QualitySample | null> | null = null;

/** Times one 0.8B paragraph after the model is loaded. Later calls reuse the stored sample. */
export function measureQuality(client: EngineClient): Promise<QualitySample | null> {
  if (pending) return pending;
  pending = run(client).finally(() => {
    pending = null;
  });
  return pending;
}

async function run(client: EngineClient): Promise<QualitySample | null> {
  const existing = await loadQualitySample();
  if (existing) return existing;

  const status = await client.status().catch(() => null);
  if (!status || status.model.id !== DEFAULT_MODEL_ID) return null;
  if (status.model.state !== 'ready' && status.model.state !== 'loaded') return null;

  if (status.model.state !== 'loaded') {
    const warmed = await client.warmModel().catch(() => null);
    if (!warmed || warmed.id !== DEFAULT_MODEL_ID || warmed.state !== 'loaded') return null;
  }

  const milliseconds = await client.benchmark().catch(() => null);
  if (milliseconds === null || milliseconds < 50) return null;

  const sample: QualitySample = {
    modelId: DEFAULT_MODEL_ID,
    milliseconds,
    measuredAt: new Date().toISOString(),
  };
  await saveQualitySample(sample);
  return sample;
}
