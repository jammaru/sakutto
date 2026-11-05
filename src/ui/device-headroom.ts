import { probeWebGpuAdapter } from '@/shared/capabilities';

export interface DeviceHeadroom {
  deviceMemoryGb: number | null;
  freeStorageBytes: number | null;
  maxBufferSize: number | null;
}

interface NavigatorWithDevice extends Navigator {
  readonly deviceMemory?: number;
}

export async function readDeviceHeadroom(): Promise<DeviceHeadroom> {
  const nav = navigator as NavigatorWithDevice;
  const deviceMemoryGb = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;

  const [freeStorageBytes, maxBufferSize] = await Promise.all([
    readFreeStorage(),
    readMaxBufferSize(),
  ]);

  return { deviceMemoryGb, freeStorageBytes, maxBufferSize };
}

async function readFreeStorage(): Promise<number | null> {
  try {
    const estimate = await navigator.storage.estimate();
    const quota = estimate.quota ?? 0;
    const usage = estimate.usage ?? 0;
    return quota > usage ? quota - usage : null;
  } catch {
    return null;
  }
}

async function readMaxBufferSize(): Promise<number | null> {
  try {
    const info = await probeWebGpuAdapter();
    return info.maxBufferSize;
  } catch {
    return null;
  }
}
