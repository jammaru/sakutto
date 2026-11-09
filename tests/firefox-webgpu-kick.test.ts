import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FIREFOX_WEBGPU_KICK,
  applyFirefoxWebGpuKickFlag,
  firefoxWebGpuKickEnabled,
  firefoxWebGpuKickWorkerBootstrap,
  withFirefoxWebGpuKickOption,
} from '@/engine/wllama/firefox-webgpu-kick';

describe('Firefox WebGPU kick switch', () => {
  it('is on by default and still gated to Firefox in the worker', () => {
    expect(FIREFOX_WEBGPU_KICK).toBe(true);
    expect(firefoxWebGpuKickEnabled()).toBe(true);
    const bootstrap = firefoxWebGpuKickWorkerBootstrap();
    expect(bootstrap).toContain('function sakuttoInstallFirefoxWebGpuKick()');
    expect(bootstrap).toContain('RUN_OPTIONS.firefoxWebGpuKick === true');
    expect(bootstrap).toContain('sakuttoInstallFirefoxWebGpuKick();');
    expect(bootstrap).toContain('var enabled = true');
    expect(bootstrap).toContain('queue.submit([])');
    expect(bootstrap).toContain('/Firefox/i.test(navigator.userAgent');
    expect(bootstrap).toContain('GPUBuffer.prototype.mapAsync = originalMapAsync');
    const verify = readFileSync(new URL('../scripts/verify-wllama.mjs', import.meta.url), 'utf8');
    for (const marker of [
      'function sakuttoInstallFirefoxWebGpuKick()',
      'RUN_OPTIONS.firefoxWebGpuKick === true',
      'sakuttoInstallFirefoxWebGpuKick();',
    ]) {
      expect(verify).toContain(marker);
      expect(bootstrap).toContain(marker);
    }
  });

  it('exposes a page-global flag the optional worker patch can read', () => {
    const target: Record<string, unknown> = {};
    applyFirefoxWebGpuKickFlag(target);
    expect(target.__SAKUTTO_FIREFOX_WEBGPU_KICK).toBe(true);
  });

  it('injects the runtime option into a worker URL so a cached wasm still kicks', () => {
    const options = { moduleUrl: 'https://example.test/wllama-module.js', noWebGPU: false };
    const href = `https://example.test/wllama-worker.js?options=${encodeURIComponent(JSON.stringify(options))}`;
    const next = String(withFirefoxWebGpuKickOption(href));
    const parsed = JSON.parse(new URL(next).searchParams.get('options') ?? '{}') as {
      firefoxWebGpuKick?: boolean;
    };
    expect(parsed.firefoxWebGpuKick).toBe(true);
    expect(String(withFirefoxWebGpuKickOption('/relative.js'))).toBe('/relative.js');
  });
});
