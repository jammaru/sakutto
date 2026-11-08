// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCapabilities, resetCapabilityProbe } from '@/shared/capabilities';

describe('WebGPU probe', () => {
  afterEach(() => {
    resetCapabilityProbe();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks for an adapter even when WebGL would be software', async () => {
    const requestAdapter = vi.fn(async () => ({ name: 'adapter' }));
    vi.stubGlobal('navigator', { gpu: { requestAdapter }, hardwareConcurrency: 4 });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const capabilities = await probeCapabilities();

    expect(capabilities.webgpu).toBe('ready');
    expect(requestAdapter).toHaveBeenCalledTimes(1);
    expect(await probeCapabilities()).toBe(capabilities);
    expect(requestAdapter).toHaveBeenCalledTimes(1);
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
    const requestAdapter = vi.fn(async () => ({ name: 'adapter' }));
    vi.stubGlobal('navigator', { gpu: { requestAdapter }, hardwareConcurrency: 8 });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as RenderingContext);

    const capabilities = await probeCapabilities();

    expect(capabilities.webgpu).toBe('ready');
    expect(requestAdapter).toHaveBeenCalledTimes(1);
    await probeCapabilities();
    expect(requestAdapter).toHaveBeenCalledTimes(1);
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

  it('reports unsupported when the browser has no WebGPU', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });

    const capabilities = await probeCapabilities();

    expect(capabilities.webgpu).toBe('unsupported');
  });
});
