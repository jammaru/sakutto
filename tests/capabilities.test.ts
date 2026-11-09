// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCapabilities, resetCapabilityProbe } from '@/shared/capabilities';
import { resetWebGpuDebugProfile, setWebGpuDebugProfile } from '@/shared/gpu-diagnostic';

describe('WebGPU probe', () => {
  afterEach(() => {
    resetCapabilityProbe();
    resetWebGpuDebugProfile();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks for an adapter even when WebGL would be software', async () => {
    const requestAdapter = vi.fn<
      (opts?: { powerPreference?: string }) => Promise<{ name: string; features: Set<string> }>
    >(async () => ({ name: 'adapter', features: new Set(['shader-f16']) }));
    vi.stubGlobal('navigator', { gpu: { requestAdapter }, hardwareConcurrency: 4 });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const capabilities = await probeCapabilities();

    expect(capabilities.webgpu).toBe('ready');
    expect(requestAdapter).toHaveBeenCalled();
    expect(requestAdapter.mock.calls[0]?.[0]).toEqual({ powerPreference: 'high-performance' });
    expect(await probeCapabilities()).toBe(capabilities);
    expect(requestAdapter).toHaveBeenCalledTimes(requestAdapter.mock.calls.length);
  });

  it.each([
    ['nvidia', true, true],
    ['amd', true, false],
    ['intel', true, false],
    ['apple', true, false],
    ['', true, false],
    ['nvidia', false, false],
  ])(
    'reports fast batches for vendor "%s" with dot product %s as %s',
    async (vendor, dot, want) => {
      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn(async () => ({ info: { vendor } })),
          wgslLanguageFeatures: new Set(dot ? ['packed_4x8_integer_dot_product'] : []),
        },
        hardwareConcurrency: 8,
      });

      expect((await probeCapabilities()).gpuFastBatches).toBe(want);
    },
  );

  it('asks once when a hardware WebGL context exists', async () => {
    const requestAdapter = vi.fn(async () => ({
      name: 'adapter',
      features: new Set(['shader-f16']),
    }));
    vi.stubGlobal('navigator', { gpu: { requestAdapter }, hardwareConcurrency: 8 });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as RenderingContext);

    const capabilities = await probeCapabilities();

    expect(capabilities.webgpu).toBe('ready');
    expect(requestAdapter).toHaveBeenCalled();
    const calls = requestAdapter.mock.calls.length;
    await probeCapabilities();
    expect(requestAdapter).toHaveBeenCalledTimes(calls);
  });

  it('asks for an adapter from a srcdoc frame on an extension page', async () => {
    const requestAdapter = vi.fn(async () => {
      throw new Error('the extension page must not call requestAdapter');
    });
    vi.stubGlobal('navigator', { gpu: { requestAdapter }, hardwareConcurrency: 4 });
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'extid',
        getURL: (path: string) => `chrome-extension://extid/${path}`,
      },
    });

    const pending = probeCapabilities();
    const frame = await vi.waitFor(() => {
      const node = document.querySelector('iframe');
      if (!(node instanceof HTMLIFrameElement) || !node.contentWindow) {
        throw new Error('waiting for the probe frame');
      }
      return node;
    });

    expect(frame.getAttribute('srcdoc')).toContain('src="chrome-extension://extid/gpu-probe.js"');
    expect(frame.getAttribute('srcdoc')).not.toContain('requestAdapter');
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { source: 'sakutto-gpu-probe', present: false, maxBufferSize: null },
      }),
    );

    const capabilities = await pending;
    expect(capabilities.webgpu).toBe('unavailable');
    expect(requestAdapter).not.toHaveBeenCalled();
  });

  it('keeps the bundled probe on the message the extension page accepts', () => {
    const source = readFileSync(resolve('public/gpu-probe.js'), 'utf8');
    expect(source).toContain("source: 'sakutto-gpu-probe'");
    expect(source).toContain('requestAdapter');
  });

  it('treats an AMD adapter with shader-f16 as WebGPU ready', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: vi.fn(async () => ({
          info: { vendor: 'amd', architecture: 'rdna3', description: 'AMD Radeon RX 7800 XT' },
          features: new Set(['shader-f16', 'subgroups']),
          limits: {
            maxBufferSize: 2_147_483_644,
            maxStorageBufferBindingSize: 2_147_483_644,
            maxComputeWorkgroupStorageSize: 32_768,
            maxComputeInvocationsPerWorkgroup: 1_024,
          },
        })),
        wgslLanguageFeatures: new Set(['packed_4x8_integer_dot_product']),
      },
      hardwareConcurrency: 16,
    });

    const capabilities = await probeCapabilities();

    expect(capabilities.webgpu).toBe('ready');
    expect(capabilities.gpuFastBatches).toBe(false);
  });

  it('treats a missing shader-f16 adapter as WebGPU unavailable', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: vi.fn(async () => ({
          info: { vendor: 'amd' },
          features: new Set(['subgroups']),
        })),
        wgslLanguageFeatures: new Set(['packed_4x8_integer_dot_product']),
      },
      hardwareConcurrency: 8,
    });

    expect((await probeCapabilities()).webgpu).toBe('unavailable');
  });

  it('skips WebGPU when the no-f16 debug profile is on', async () => {
    setWebGpuDebugProfile('no-f16');
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: vi.fn(async () => ({
          info: { vendor: 'nvidia' },
          features: new Set(['shader-f16', 'subgroups']),
        })),
        wgslLanguageFeatures: new Set(['packed_4x8_integer_dot_product']),
      },
      hardwareConcurrency: 8,
    });

    expect((await probeCapabilities()).webgpu).toBe('unavailable');
  });

  it('reports unsupported when the browser has no WebGPU', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });

    const capabilities = await probeCapabilities();

    expect(capabilities.webgpu).toBe('unsupported');
  });
});
