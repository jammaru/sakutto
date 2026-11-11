import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  renderModuleScript,
  renderPthreadScript,
  renderWorkerScript,
} from '../scripts/wllama/artifacts';
import { assertWave64ProbePlacement } from '../scripts/wllama/webgpu-patch';

const GLUE =
  'var Module=typeof Module!="undefined"?Module:{};var ENVIRONMENT_IS_PTHREAD=false;var mainScriptUrlOrBlob="/wllama-pthread.js";';

const WORKER_CODE = [
  '// const getWModuleConfig',
  '// mainScriptUrlOrBlob',
  "// verb === 'module.init'",
  'globalThis.__result = RUN_OPTIONS;',
].join('\n');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef';

describe('wllama artifact rendering', () => {
  it('boots the worker from the run options in its url', () => {
    const source = renderWorkerScript(WORKER_CODE);

    expect(source).toContain("searchParams.get('options')");
    expect(source).toContain('importScripts(RUN_OPTIONS.moduleUrl)');
    expect(source).toContain('RUN_OPTIONS.noWebGPU');
    expect(source).toContain('sakuttoInstallFirefoxWebGpuKick');
    expect(source).toContain('var enabled = true');
    expect(source).toContain('RUN_OPTIONS.webgpuDebug');
    expect(source).toContain('__SAKUTTO_WEBGPU_DEBUG__');
    expect(source.replace(/\r\n/g, '\n').trimEnd().endsWith(WORKER_CODE.trimEnd())).toBe(true);
  });

  it('round-trips extension urls through the worker query string', () => {
    const options = {
      pathConfig: {
        'wllama.wasm': `${EXTENSION_ORIGIN}/vendor/wllama/wllama.wasm`,
      },
      nbThread: 0,
      compat: false,
      noWebGPU: true,
      moduleUrl: `${EXTENSION_ORIGIN}/vendor/wllama/wllama-module.js`,
    };
    const workerUrl = `${EXTENSION_ORIGIN}/vendor/wllama/wllama-worker.js?options=${encodeURIComponent(JSON.stringify(options))}`;

    const sandbox: Record<string, unknown> = {
      self: { location: { href: workerUrl } },
      URL,
      importScripts: () => undefined,
      WorkerNavigator: class {},
    };
    runInNewContext(renderWorkerScript(WORKER_CODE), sandbox);

    expect(sandbox.__result).toBeDefined();
    expect(JSON.parse(JSON.stringify(sandbox.__result))).toEqual(options);
  });

  it('refuses worker code that no longer matches the bootstrap', () => {
    expect(() => renderWorkerScript('onmessage = () => {};')).toThrow(/review the static worker/);
  });

  it('wraps the glue in a module initializer after the JSPI stub', () => {
    const source = renderModuleScript(GLUE, 'JSPI module');
    const stubIndex = source.indexOf('WebAssembly.Suspending');
    const glueIndex = source.indexOf('var ___Module');
    const returnIndex = source.lastIndexOf('return Module;');

    expect(source.startsWith('// SPDX-License-Identifier: MIT')).toBe(true);
    expect(source).toContain('function wModuleInit() {');
    expect(source).not.toContain('var Module=');
    expect(stubIndex).toBeGreaterThan(-1);
    expect(glueIndex).toBeGreaterThan(stubIndex);
    expect(returnIndex).toBeGreaterThan(glueIndex);
  });

  it('refuses glue without a single Module declaration', () => {
    expect(() => renderModuleScript('var x = 1;', 'module')).toThrow(/"var Module" 0 times/);
    expect(() => renderModuleScript(`${GLUE} var Module = {};`, 'module')).toThrow(
      /"var Module" 2 times/,
    );
  });

  it('keeps the pthread entry as a plain script', () => {
    const source = renderPthreadScript(GLUE, 'JSPI pthread entry');

    expect(source).toContain(GLUE);
    expect(source).toContain('WebAssembly.Suspending');
    expect(source).not.toContain('wModuleInit');
  });

  it('keeps subgroups on WebGPU limit retries and re-derives them from the device', () => {
    const patch = readFileSync(
      new URL('../scripts/wllama/patches/0007-webgpu-adapter-device-retry.patch', import.meta.url),
      'utf8',
    );
    expect(patch).toContain('capped-limits optional-features');
    expect(patch).toContain('ggml_webgpu_apply_granted_device_caps');
    expect(patch).toContain('device.HasFeature(wgpu::FeatureName::Subgroups)');
    expect(patch).toContain('reject-max-limits');
    expect(patch).toContain('correctness probe');
    expect(patch).toContain('Never guess a size');
    expect(patch).not.toContain('capped-limits shader-f16');
    expect(patch).not.toContain('subgroup-64');
    expect(patch).not.toContain('min_sg = 32');
    expect(patch).not.toContain('max_sg = 64');
  });

  it('turns vec flash-attn off for a subgroup wider than 32 and checks an f16 matmul', () => {
    const patch = readFileSync(
      new URL('../scripts/wllama/patches/0009-webgpu-wave64-flash-attn.patch', import.meta.url),
      'utf8',
    );
    expect(patch).toContain('caps.flash_attn_vec');
    expect(patch).toContain('subgroup_size > 32u');
    expect(patch).toContain('ggml_webgpu_probe_f16_matmul_wgsl');
    expect(patch).toContain('GGML_WEBGPU_PROBE_F16_MATMUL = 10');
    expect(patch).toContain('subgroupShuffleDown');
    expect(patch).toContain('tile attention needs');
    expect(patch).toContain('not a claim that a Radeon was retested');
    expect(patch).toContain('+    caps.subgroup_size            = 0;\n+}');
  });

  it('accepts the applied 0009 brace shape and rejects a stray extra closer', () => {
    const valid = `
void ggml_webgpu_disable_subgroups(webgpu_context ctx) {
    caps.max_subgroup_size        = 0;
    caps.flash_attn_vec           = false;
    caps.subgroup_size            = 0;
}

static const char * ggml_webgpu_probe_f16_sum_wgsl() {
    return "";
}

static const char * ggml_webgpu_probe_shuffle_down_wgsl() {
    return "";
}

bool ggml_webgpu_correctness_probe(webgpu_context ctx) {
    return true;
}
`;
    expect(() => assertWave64ProbePlacement(valid)).not.toThrow();

    const extraCloser = valid.replace(
      'caps.subgroup_size            = 0;\n}',
      'caps.subgroup_size            = 0;\n}\n}',
    );
    expect(() => assertWave64ProbePlacement(extraCloser)).toThrow(/extra closing brace/);
  });
});
