import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DAWN_TAG, LLAMA_CPP_COMMIT, WLLAMA_COMMIT, WLLAMA_REPOSITORY } from './pins.ts';
import { exists, log, readText, sha256, writeText } from './support.ts';

export const WASM_FILE = 'wllama.wasm';
export const COMPAT_WASM_FILE = 'wllama-compat.wasm';
export const MANIFEST_FILE = 'wllama-build.json';

const BASE_FILES = [
  'wllama.js',
  WASM_FILE,
  'wllama-worker.js',
  'wllama-module.js',
  'wllama-pthread.js',
] as const;

const COMPAT_FILES = [
  COMPAT_WASM_FILE,
  'wllama-compat-module.js',
  'wllama-compat-pthread.js',
] as const;

const MINIMUM_BYTES: Record<string, number> = {
  'wllama.js': 50_000,
  [WASM_FILE]: 4 * 1024 * 1024,
  'wllama-worker.js': 10_000,
  'wllama-module.js': 50_000,
  'wllama-pthread.js': 50_000,
  [COMPAT_WASM_FILE]: 4 * 1024 * 1024,
  'wllama-compat-module.js': 50_000,
  'wllama-compat-pthread.js': 50_000,
};

// Copied from the static worker bootstrap that the pinned source used to inline.
const JSPI_STUB = `if (!WebAssembly.Suspending) {
  WebAssembly.Suspending = function (fn) {
    return fn;
  };
  WebAssembly.promising = function (fn) {
    return function (...args) {
      try {
        return Promise.resolve(fn(...args));
      } catch (e) {
        return Promise.reject(e);
      }
    };
  };
}`;

export interface FileRecord {
  bytes: number;
  sha256: string;
  minimumBytes: number;
}

export interface BuildInputs {
  emscriptenTag: string;
  compat: boolean;
  tsupVersion: string;
  packageLockSha256: string;
}

export interface BuildManifest {
  schemaVersion: number;
  wllama: { repository: string; commit: string };
  llamaCpp: { commit: string };
  emscripten: { image: string; tag: string };
  dawn: { tag: string };
  toolchain: { node: string; tsup: string; packageLockSha256: string };
  features: string[];
  compat: boolean;
  patches: { file: string; sha256: string }[];
  files: Record<string, FileRecord>;
}

export function artifactFiles(compat: boolean): readonly string[] {
  return compat ? [...BASE_FILES, ...COMPAT_FILES] : BASE_FILES;
}

export function minimumBytesFor(name: string): number {
  const minimum = MINIMUM_BYTES[name];
  if (minimum === undefined) throw new Error(`no minimum size is defined for ${name}`);
  return minimum;
}

function licenseHeader(kind: string): string {
  return [
    '// SPDX-License-Identifier: MIT',
    `// Generated ${kind} from ngxson/wllama@${WLLAMA_COMMIT} (MIT) with llama.cpp (MIT).`,
    '// Contains the Emscripten runtime (MIT / University of Illinois/NCSA).',
    '// License texts are packaged at the extension root under licenses/. Do not edit.',
  ].join('\n');
}

export function renderModuleScript(glueJs: string, kind: string): string {
  const declarations = glueJs.match(/var Module\b/g) ?? [];
  if (declarations.length !== 1) {
    throw new Error(
      `the emscripten glue declares "var Module" ${declarations.length} times; review the module wrapper`,
    );
  }
  for (const marker of ['ENVIRONMENT_IS_PTHREAD', 'mainScriptUrlOrBlob']) {
    if (!glueJs.includes(marker)) {
      throw new Error(
        `the emscripten glue no longer contains "${marker}"; review the module wrapper`,
      );
    }
  }
  const renamed = `${JSPI_STUB}\n${glueJs}`.replace(/var Module\b/, 'var ___Module');
  return `${licenseHeader(kind)}\nfunction wModuleInit() { ${renamed}; return Module; }\n`;
}

export function renderPthreadScript(glueJs: string, kind: string): string {
  for (const marker of ['var Module', 'ENVIRONMENT_IS_PTHREAD', 'mainScriptUrlOrBlob']) {
    if (!glueJs.includes(marker)) {
      throw new Error(
        `the emscripten glue no longer contains "${marker}"; review the pthread wrapper`,
      );
    }
  }
  return `${licenseHeader(kind)}\n${JSPI_STUB}\n${glueJs}\n`;
}

export function renderWorkerScript(llamaCppJs: string): string {
  for (const marker of [
    'const getWModuleConfig',
    'mainScriptUrlOrBlob',
    "verb === 'module.init'",
  ]) {
    if (!llamaCppJs.includes(marker)) {
      throw new Error(
        `the worker code no longer contains "${marker}"; review the static worker bootstrap`,
      );
    }
  }

  return `// SPDX-License-Identifier: MIT
// Generated worker from ngxson/wllama@${WLLAMA_COMMIT} (MIT). Do not edit.
const RUN_OPTIONS = JSON.parse(new URL(self.location.href).searchParams.get('options') || 'null');
if (!RUN_OPTIONS) {
  throw new Error('the wllama worker was started without run options');
}
if (RUN_OPTIONS.noWebGPU) {
  try {
    Object.defineProperty(WorkerNavigator.prototype, 'gpu', {
      get: () => ({ requestAdapter: async () => null }),
    });
  } catch (e) {}
}
importScripts(RUN_OPTIONS.moduleUrl);
${llamaCppJs}
`;
}

async function collectFileRecords(
  directory: string,
  compat: boolean,
): Promise<Record<string, FileRecord>> {
  const records: Record<string, FileRecord> = {};
  for (const name of artifactFiles(compat)) {
    const contents = await readFile(join(directory, name));
    const minimumBytes = minimumBytesFor(name);
    const record = { bytes: contents.byteLength, sha256: sha256(contents), minimumBytes };
    if (record.bytes < minimumBytes) {
      throw new Error(`${name} is only ${record.bytes} bytes; the build looks incomplete`);
    }
    records[name] = record;
  }
  return records;
}

export async function emitArtifacts(
  stagingDir: string,
  patchDir: string,
  checkoutDir: string,
  inputs: BuildInputs,
): Promise<BuildManifest> {
  const glueJs = await readText(join(checkoutDir, 'src', 'wasm', 'wllama.js'));
  const compatGlueJs = inputs.compat
    ? await readText(join(checkoutDir, 'compat', 'wasm', 'wllama.js'))
    : '';
  const llamaCppJs = await readText(join(checkoutDir, 'src', 'workers-code', 'llama-cpp.js'));
  const library = join(checkoutDir, 'esm', 'index.js');

  if (!(await exists(library))) {
    throw new Error('the wllama library bundle is missing');
  }

  await mkdir(stagingDir, { recursive: true });

  await copyFile(library, join(stagingDir, 'wllama.js'));
  await copyFile(join(checkoutDir, 'src', 'wasm', 'wllama.wasm'), join(stagingDir, WASM_FILE));
  await writeText(join(stagingDir, 'wllama-worker.js'), renderWorkerScript(llamaCppJs));
  await writeText(join(stagingDir, 'wllama-module.js'), renderModuleScript(glueJs, 'JSPI module'));
  await writeText(
    join(stagingDir, 'wllama-pthread.js'),
    renderPthreadScript(glueJs, 'JSPI pthread entry'),
  );

  if (inputs.compat) {
    await copyFile(
      join(checkoutDir, 'compat', 'wasm', 'wllama.wasm'),
      join(stagingDir, COMPAT_WASM_FILE),
    );
    await writeText(
      join(stagingDir, 'wllama-compat-module.js'),
      renderModuleScript(compatGlueJs, 'compat module'),
    );
    await writeText(
      join(stagingDir, 'wllama-compat-pthread.js'),
      renderPthreadScript(compatGlueJs, 'compat pthread entry'),
    );
  }

  const files = await collectFileRecords(stagingDir, inputs.compat);

  const patches = [];
  for (const name of (await readdir(patchDir)).filter((entry) => entry.endsWith('.patch')).sort()) {
    patches.push({ file: name, sha256: sha256(await readFile(join(patchDir, name))) });
  }

  const manifest: BuildManifest = {
    schemaVersion: 1,
    wllama: { repository: WLLAMA_REPOSITORY, commit: WLLAMA_COMMIT },
    llamaCpp: { commit: LLAMA_CPP_COMMIT },
    emscripten: {
      image: `emscripten/emsdk:${inputs.emscriptenTag}`,
      tag: inputs.emscriptenTag,
    },
    dawn: { tag: DAWN_TAG },
    toolchain: {
      node: process.version,
      tsup: inputs.tsupVersion,
      packageLockSha256: inputs.packageLockSha256,
    },
    features: inputs.compat
      ? ['webgpu', 'jspi', 'memory64', 'compat']
      : ['webgpu', 'jspi', 'memory64'],
    compat: inputs.compat,
    patches,
    files,
  };

  await writeText(join(stagingDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

  log(`wrote ${Object.keys(files).length + 1} files to ${stagingDir}`);
  return manifest;
}
