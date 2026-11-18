// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectBackend } from '@/engine/in-browser/backend';
import {
  isHardWebGpuFailure,
  lastWebGpuAdapterInfo,
  probeCapabilities,
  resetCapabilityProbe,
} from '@/shared/capabilities';
import { resetWebGpuDebugProfile, setWebGpuDebugProfile } from '@/shared/gpu-diagnostic';
import { ADAPTER_FIRST_OVERALL_TIMEOUT_MS } from '@/shared/webgpu-adapter';

describe('WebGPU probe', () => {
  afterEach(() => {
    resetCapabilityProbe();
    resetWebGpuDebugProfile();
    vi.useRealTimers();
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

  it('treats a requestAdapter that never resolves as unavailable and selects the CPU', async () => {
    vi.useFakeTimers();
    const requestAdapter = vi.fn(() => new Promise<never>(() => undefined));
    vi.stubGlobal('navigator', { gpu: { requestAdapter }, hardwareConcurrency: 8 });

    const pending = probeCapabilities();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ADAPTER_FIRST_OVERALL_TIMEOUT_MS);
    const capabilities = await pending;

    expect(capabilities.webgpu).toBe('unavailable');
    expect(requestAdapter).toHaveBeenCalled();
    expect(
      selectBackend({
        webgpu: capabilities.webgpu === 'ready',
        hardwareConcurrency: capabilities.hardwareConcurrency,
        ...(capabilities.gpuFastBatches === undefined
          ? {}
          : { fastBatches: capabilities.gpuFastBatches }),
      }).backend,
    ).toBe('cpu-wasm');
  });

  it('selects WebGPU on Linux X11 when the adapter has shader-f16', async () => {
    const requestAdapter = vi.fn(async () => ({
      info: { vendor: 'amd', description: 'AMD Radeon RX 7800 XT' },
      features: new Set(['shader-f16']),
    }));
    vi.stubGlobal('navigator', {
      userAgentData: { platform: 'Linux' },
      platform: 'Linux x86_64',
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      gpu: { requestAdapter },
      hardwareConcurrency: 16,
    });

    const capabilities = await probeCapabilities();

    expect(capabilities.webgpu).toBe('ready');
    expect(
      selectBackend({
        webgpu: capabilities.webgpu === 'ready',
        hardwareConcurrency: capabilities.hardwareConcurrency,
        ...(capabilities.gpuFastBatches === undefined
          ? {}
          : { fastBatches: capabilities.gpuFastBatches }),
      }),
    ).toMatchObject({ backend: 'webgpu', tier: 'g' });
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

  it('falls through to the direct adapter search when the quiet frame has no adapter', async () => {
    const requestAdapter = vi.fn(async () => ({
      info: { vendor: 'amd', description: 'AMD Radeon Vega' },
      features: new Set(['shader-f16']),
    }));
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
    expect(capabilities.webgpu).toBe('ready');
    // The quiet frame's empty answer must not short-circuit the retrying direct search.
    expect(requestAdapter).toHaveBeenCalled();
    expect(
      selectBackend({
        webgpu: capabilities.webgpu === 'ready',
        hardwareConcurrency: capabilities.hardwareConcurrency,
        fastBatches: capabilities.gpuFastBatches === true,
      }),
    ).toMatchObject({ backend: 'webgpu', tier: 'g' });
  });

  it('falls through when the quiet frame finds an adapter without shader-f16', async () => {
    const requestAdapter = vi.fn(async () => ({
      info: { vendor: 'amd' },
      features: new Set(['shader-f16']),
    }));
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
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: {
          source: 'sakutto-gpu-probe',
          present: true,
          vendor: 'amd',
          shaderF16: false,
          maxBufferSize: null,
        },
      }),
    );

    expect((await pending).webgpu).toBe('ready');
    expect(requestAdapter).toHaveBeenCalled();
  });

  it('does not cache a soft empty adapter answer for the session', async () => {
    let empty = true;
    const requestAdapter = vi.fn(async () => {
      if (empty) return null;
      return { info: { vendor: 'amd' }, features: new Set(['shader-f16']) };
    });
    vi.stubGlobal('navigator', { gpu: { requestAdapter }, hardwareConcurrency: 8 });

    expect((await probeCapabilities()).webgpu).toBe('unavailable');
    expect(lastWebGpuAdapterInfo()?.diagnostic.error).toBeNull();
    expect(isHardWebGpuFailure(lastWebGpuAdapterInfo())).toBe(false);
    // The soft result is cleared after its callers have read the diagnostic.
    await new Promise((resolve) => setTimeout(resolve, 0));

    empty = false;
    expect((await probeCapabilities()).webgpu).toBe('ready');
    expect(requestAdapter.mock.calls.length).toBeGreaterThan(1);
  });

  it('keeps a hard missing-WebGPU answer cached', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });

    const capabilities = await probeCapabilities();

    expect(capabilities.webgpu).toBe('unsupported');
    expect(isHardWebGpuFailure(lastWebGpuAdapterInfo())).toBe(true);
    expect(await probeCapabilities()).toBe(capabilities);
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
