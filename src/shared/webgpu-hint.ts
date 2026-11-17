import { extensionBrowser, isLinuxPlatform, type ExtensionBrowser } from './browser';
import type { WebGpuStatus } from './capabilities';

export interface LinuxWebGpuHintOptions {
  readonly browser?: ExtensionBrowser | undefined;
  readonly linux?: boolean | undefined;
}

export type LinuxWebGpuHintKey =
  'engineLinuxWebGpuHintUnsupported' | 'engineLinuxWebGpuHintUnavailable';

/**
 * The two Linux outcomes need different advice: a missing API may be a flag, but an API
 * with no adapter is a driver/Vulkan problem and the flag is already on.
 */
export function linuxWebGpuHintKey(
  webgpu: WebGpuStatus | null | undefined,
): LinuxWebGpuHintKey | null {
  if (webgpu === 'unsupported') return 'engineLinuxWebGpuHintUnsupported';
  if (webgpu === 'unavailable') return 'engineLinuxWebGpuHintUnavailable';
  return null;
}

/**
 * A probe that merely failed may be transient, and a ready adapter needs no hint, so only
 * the CPU-due-to-GPU cases show it on Chrome for Linux.
 */
export function linuxWebGpuHintVisible(
  webgpu: WebGpuStatus | null | undefined,
  options: LinuxWebGpuHintOptions = {},
): boolean {
  if ((options.browser ?? extensionBrowser()) !== 'chrome') return false;
  if (!(options.linux ?? isLinuxPlatform())) return false;
  return linuxWebGpuHintKey(webgpu) !== null;
}
