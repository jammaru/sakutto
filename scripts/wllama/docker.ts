import { join } from 'node:path';
import { EMSDK_TAG } from './pins.ts';
import { exists, log, run } from './support.ts';

const WASM_SOURCE_FILES = [
  join('src', 'wasm', 'wllama.js'),
  join('src', 'wasm', 'wllama.wasm'),
] as const;

const COMPAT_WASM_SOURCE_FILES = [
  join('compat', 'wasm', 'wllama.js'),
  join('compat', 'wasm', 'wllama.wasm'),
] as const;

/**
 * Emscripten reports an x86 processor unless told otherwise, and ggml then compiles its
 * scalar fallback instead of the wasm SIMD dot products. The 0003 patch sets the processor;
 * this object only exists when the SIMD kernels were built.
 */
const WASM_KERNEL_OBJECT = join(
  'llama.cpp',
  'ggml',
  'src',
  'CMakeFiles',
  'ggml-cpu.dir',
  'ggml-cpu',
  'arch',
  'wasm',
  'quants.c.o',
);

export async function assertWasmKernels(checkoutDir: string, compat: boolean): Promise<void> {
  for (const dir of compat ? ['build', 'build-compat'] : ['build']) {
    if (!(await exists(join(checkoutDir, dir, WASM_KERNEL_OBJECT)))) {
      throw new Error(
        `the ${dir} wasm build used ggml's generic CPU kernels; check that the 0003 patch set EMSCRIPTEN_SYSTEM_PROCESSOR`,
      );
    }
  }
}

export function emsdkTag(arch: string): string {
  return arch === 'arm64' ? `${EMSDK_TAG}-arm64` : EMSDK_TAG;
}

export function emsdkImage(tag: string): string {
  return `emscripten/emsdk:${tag}`;
}

async function assertDocker(): Promise<void> {
  try {
    await run('docker', ['compose', 'version']);
  } catch {
    throw new Error('Docker Compose v2 is required. Install Docker Desktop or docker compose v2.');
  }

  try {
    await run('docker', ['info']);
  } catch {
    throw new Error('The Docker daemon is not reachable. Start Docker and retry.');
  }
}

export async function buildWasm(checkoutDir: string, arch: string, compat: boolean): Promise<void> {
  await assertDocker();

  const tag = emsdkTag(arch);
  const image = emsdkImage(tag);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EMSDK_IMAGE_TAG: tag,
    WLLAMA_TEST_BACKEND: '',
    SKIP_COMPAT: compat ? '' : '1',
    D_UID: String(process.getuid?.() ?? 0),
    D_GID: String(process.getgid?.() ?? 0),
  };
  if (arch === 'arm64') {
    env.DOCKER_DEFAULT_PLATFORM = 'linux/arm64';
  }

  log(`building wasm with ${image} (WebGPU, JSPI${compat ? ' and compat' : ''})`);
  await run(
    'docker',
    ['compose', 'up', 'llamacpp-wasm-builder', '--exit-code-from', 'llamacpp-wasm-builder'],
    { cwd: join(checkoutDir, 'scripts'), env, mode: 'inherit' },
  );

  const expected = compat ? [...WASM_SOURCE_FILES, ...COMPAT_WASM_SOURCE_FILES] : WASM_SOURCE_FILES;
  for (const file of expected) {
    if (!(await exists(join(checkoutDir, file)))) {
      throw new Error(`the wasm build did not produce ${file}`);
    }
  }
  await assertWasmKernels(checkoutDir, compat);
}
