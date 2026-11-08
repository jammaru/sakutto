import { copyFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitArtifacts, type BuildInputs } from './artifacts.ts';
import { buildWasm, emsdkTag } from './docker.ts';
import { LLAMA_CPP_COMMIT, WLLAMA_COMMIT, WLLAMA_REPOSITORY } from './pins.ts';
import { exists, log, readText, run, sha256 } from './support.ts';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENDOR_DIR = join(ROOT_DIR, 'vendor', 'wllama');
const CHECKOUT_DIR = join(VENDOR_DIR, '.checkout');
const DIST_DIR = join(VENDOR_DIR, 'dist');
const STAGING_DIR = join(VENDOR_DIR, '.dist-staging');
const PUBLIC_DIR = join(ROOT_DIR, 'public', 'vendor', 'wllama');
const PATCH_DIR = join(ROOT_DIR, 'scripts', 'wllama', 'patches');

const PATCH_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['src/utils.ts', 'return new Worker(url.href);'],
  ['src/utils.ts', "url.searchParams.set('options', JSON.stringify(runOptions));"],
  ['src/worker.ts', 'this.worker = createWorker(this.resources.workerUrl, runOptions);'],
  ['src/worker.ts', 'compat ? this.resources.compatPthreadUrl : this.resources.pthreadUrl'],
  ['src/wllama.ts', "this.pathConfig['wllama.worker.js']"],
  ['src/wllama.ts', "this.pathConfig['wllama.pthread.js']"],
  ['src/wllama.ts', "const compatWasm = this.pathConfig['wllama.compat.wasm'];"],
  [
    'scripts/docker-compose.yml',
    'emcmake cmake .. -DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm32 -DGGML_WEBGPU=ON',
  ],
  [
    'scripts/docker-compose.yml',
    'emcmake cmake .. -DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm32 -DWLLAMA_COMPAT=ON',
  ],
  [
    'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp',
    'std::unordered_map<std::string, wgpu::BindGroup> bind_group_cache;',
  ],
  [
    'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp',
    'ctx->param_arena.flush(ctx->global_ctx->queue);',
  ],
  ['llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp', 'ggml_webgpu_append_mmvq_columns(ctx, src0'],
  ['cpp/wllama-context.h', 'params.n_ctx_checkpoints = 0;'],
  ['cpp/wllama-context.h', 'params.cache_ram_mib = 0;'],
  [
    'llama.cpp/tools/server/server-context.cpp',
    'task->is_stateless() || !task->params.cache_prompt',
  ],
];

function git(args: readonly string[], cwd = CHECKOUT_DIR): Promise<string> {
  return run(
    'git',
    ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args],
    {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );
}

async function ensureCheckout(): Promise<void> {
  if (await exists(join(CHECKOUT_DIR, '.git'))) {
    const origin = await git(['remote', 'get-url', 'origin']).catch(() => '');
    if (origin && origin !== WLLAMA_REPOSITORY) {
      throw new Error(
        `${CHECKOUT_DIR} points at ${origin}, expected ${WLLAMA_REPOSITORY}. Remove the directory and retry.`,
      );
    }
    if (!origin) {
      await git(['remote', 'add', 'origin', WLLAMA_REPOSITORY]);
    }
  } else {
    await mkdir(CHECKOUT_DIR, { recursive: true });
    await git(['init', '--quiet']);
    await git(['remote', 'add', 'origin', WLLAMA_REPOSITORY]);
    log(`cloned ${WLLAMA_REPOSITORY}`);
  }

  await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'core.eol', 'lf']);

  const head = await git(['rev-parse', 'HEAD']).catch(() => '');
  if (head !== WLLAMA_COMMIT) {
    const known = await git(['cat-file', '-e', `${WLLAMA_COMMIT}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (!known) {
      log(`fetching ${WLLAMA_COMMIT}`);
      try {
        await git(['fetch', '--depth', '1', 'origin', WLLAMA_COMMIT]);
      } catch {
        await git(['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
      }
    }
    await git(['checkout', '--detach', WLLAMA_COMMIT]);
  }

  const pinned = await git(['rev-parse', 'HEAD']);
  if (pinned !== WLLAMA_COMMIT) {
    throw new Error(`wllama checkout is at ${pinned}, expected ${WLLAMA_COMMIT}`);
  }

  const linked = await git(['rev-parse', 'HEAD:llama.cpp']);
  if (linked !== LLAMA_CPP_COMMIT) {
    throw new Error(
      `wllama @${WLLAMA_COMMIT} expects llama.cpp ${LLAMA_CPP_COMMIT}, found ${linked}`,
    );
  }

  if (!(await exists(join(CHECKOUT_DIR, 'llama.cpp', '.git')))) {
    log('fetching the llama.cpp submodule');
    try {
      await git(['submodule', 'update', '--init', '--recursive', '--depth', '1']);
    } catch {
      await git(['submodule', 'update', '--init', '--recursive']);
    }
  }

  const llamaCpp = await git(['rev-parse', 'HEAD'], join(CHECKOUT_DIR, 'llama.cpp'));
  if (llamaCpp !== LLAMA_CPP_COMMIT) {
    throw new Error(`llama.cpp checkout is at ${llamaCpp}, expected ${LLAMA_CPP_COMMIT}`);
  }
}

async function resetCheckout(): Promise<void> {
  // A superproject reset leaves the submodule's files alone, and a patch applies into llama.cpp.
  await git(['checkout', '--', '.'], join(CHECKOUT_DIR, 'llama.cpp'));
  await git(['reset', '--hard', WLLAMA_COMMIT]);
  await git([
    'clean',
    '-fd',
    '-e',
    'node_modules',
    '-e',
    '.npm-cache',
    '-e',
    'build',
    '-e',
    'build-compat',
    '-e',
    'esm',
  ]);
}

async function applyPatches(): Promise<void> {
  const patches = (await readdir(PATCH_DIR)).filter((name) => name.endsWith('.patch')).sort();
  if (patches.length === 0) {
    throw new Error(`no patches found in ${PATCH_DIR}`);
  }

  for (const name of patches) {
    const patch = join(PATCH_DIR, name);
    try {
      await git(['apply', '--check', patch]);
    } catch (error) {
      throw new Error(
        `${name} does not apply to wllama @${WLLAMA_COMMIT}. Review the patch against the pinned source.`,
        { cause: error },
      );
    }
    await git(['apply', patch]);
    log(`applied ${name}`);
  }

  for (const [file, marker] of PATCH_MARKERS) {
    const contents = await readText(join(CHECKOUT_DIR, file));
    if (!contents.includes(marker)) {
      throw new Error(
        `${file} does not contain the expected patched code (${marker}). Review the patches against the pinned source.`,
      );
    }
  }
}

async function runNpm(args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform === 'win32') {
    // npm is a .cmd shim, so it has to run through the command interpreter.
    await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], {
      cwd: CHECKOUT_DIR,
      env,
      mode: 'inherit',
    });
  } else {
    await run('npm', args, { cwd: CHECKOUT_DIR, env, mode: 'inherit' });
  }
}

async function buildLibrary(): Promise<{ tsupVersion: string }> {
  log('installing wllama build dependencies');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_cache: join(VENDOR_DIR, '.npm-cache'),
  };

  await runNpm(['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], env);

  log('bundling the wllama library');
  await runNpm(
    ['exec', '--', 'tsup', 'src/index.ts', '--format', 'cjs,esm', '--clean'],
    process.env,
  );

  if (!(await exists(join(CHECKOUT_DIR, 'esm', 'index.js')))) {
    throw new Error('the wllama library build did not produce esm/index.js');
  }

  const packageJson = JSON.parse(
    await readText(join(CHECKOUT_DIR, 'node_modules', 'tsup', 'package.json')),
  ) as { version?: unknown };
  if (typeof packageJson.version !== 'string') {
    throw new Error('the tsup package does not declare a version');
  }
  return { tsupVersion: packageJson.version };
}

async function syncPublicAssets(): Promise<void> {
  await rm(PUBLIC_DIR, { recursive: true, force: true });
  await mkdir(PUBLIC_DIR, { recursive: true });

  for (const name of await readdir(DIST_DIR)) {
    await copyFile(join(DIST_DIR, name), join(PUBLIC_DIR, name));
  }

  log(`copied the assets to ${PUBLIC_DIR}`);
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  log(`pinned wllama @${WLLAMA_COMMIT} with llama.cpp @${LLAMA_CPP_COMMIT}`);

  if (!checkOnly) {
    await rm(PUBLIC_DIR, { recursive: true, force: true });
  }

  await ensureCheckout();
  await resetCheckout();
  await applyPatches();

  if (checkOnly) {
    log('the pinned sources and patches are valid');
    return;
  }

  const compat = process.env.SKIP_COMPAT !== '1';
  const { tsupVersion } = await buildLibrary();
  const tag = emsdkTag(process.arch);
  await buildWasm(CHECKOUT_DIR, process.arch, compat);

  const packageLockSha256 = sha256(await readFile(join(CHECKOUT_DIR, 'package-lock.json')));
  const inputs: BuildInputs = {
    emscriptenTag: tag,
    compat,
    tsupVersion,
    packageLockSha256,
  };

  await rm(DIST_DIR, { recursive: true, force: true });
  await rm(STAGING_DIR, { recursive: true, force: true });
  await emitArtifacts(STAGING_DIR, PATCH_DIR, CHECKOUT_DIR, inputs);
  await rename(STAGING_DIR, DIST_DIR);
  await syncPublicAssets();
  log('done');
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPoint === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`[wllama] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
