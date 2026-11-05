import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  renderModuleScript,
  renderPthreadScript,
  renderWorkerScript,
} from '../scripts/wllama/artifacts';

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
    expect(source.trimEnd().endsWith(WORKER_CODE.trimEnd())).toBe(true);
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
});
