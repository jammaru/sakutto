import { extensionBrowser, isLinuxPlatform, type ExtensionBrowser } from './browser';
import type { WebGpuStatus } from './capabilities';

export interface LinuxWebGpuHintOptions {
  readonly browser?: ExtensionBrowser | undefined;
  readonly linux?: boolean | undefined;
}

/**
 * The Linux flag hint explains a missing WebGPU adapter. A probe that merely failed may be
 * transient, and a ready adapter needs no hint, so only the CPU-due-to-GPU cases show it.
 */
export function linuxWebGpuHintVisible(
  webgpu: WebGpuStatus | null | undefined,
  options: LinuxWebGpuHintOptions = {},
): boolean {
  if ((options.browser ?? extensionBrowser()) !== 'chrome') return false;
  if (!(options.linux ?? isLinuxPlatform())) return false;
  return webgpu === 'unsupported' || webgpu === 'unavailable';
}
