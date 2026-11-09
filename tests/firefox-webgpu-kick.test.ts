import { describe, expect, it } from 'vitest';
import {
  FIREFOX_WEBGPU_KICK,
  applyFirefoxWebGpuKickFlag,
  firefoxWebGpuKickEnabled,
  firefoxWebGpuKickWorkerBootstrap,
} from '@/engine/wllama/firefox-webgpu-kick';

describe('Firefox WebGPU kick switch', () => {
  it('stays off until a Windows Firefox GPU run verifies it', () => {
    expect(FIREFOX_WEBGPU_KICK).toBe(false);
    expect(firefoxWebGpuKickEnabled()).toBe(false);
    expect(firefoxWebGpuKickWorkerBootstrap()).toContain('var enabled = false');
    expect(firefoxWebGpuKickWorkerBootstrap()).toContain('queue.submit([])');
  });

  it('exposes a page-global flag the optional worker patch can read', () => {
    const target: Record<string, unknown> = {};
    applyFirefoxWebGpuKickFlag(target);
    expect(target.__SAKUTTO_FIREFOX_WEBGPU_KICK).toBe(false);
  });
});
