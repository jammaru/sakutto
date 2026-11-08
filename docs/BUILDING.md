# Building the bundled wllama

The extension runs PLaMo 3 Translate with a pinned wllama build. The published npm package
(`@wllama/wllama` 3.8.1) cannot load the PLaMo 3 tokenizer, so the extension ships its own build of
[ngxson/wllama](https://github.com/ngxson/wllama) at commit `d275dac` (llama.cpp `5aeac37`,
2026-10-18) with two MV3 patches, one build-flag patch and two
run-time patches.

## Requirements

- Node 24 and pnpm 12
- Docker Desktop (or Docker Engine with Compose v2); `emcc` is not required on the host
- Network access for the pinned git checkouts, the emsdk image, the Dawn package and npm
- Several GB of free disk space and tens of minutes for a cold build; the wasm is compiled twice
  (JSPI and compat) unless `SKIP_COMPAT=1`

## Command

```sh
pnpm build:wllama
pnpm verify:wllama
```

The script runs these steps:

1. Fetches `d275dac` into `vendor/wllama/.checkout` with a depth-1 fetch (falling back to the full
   branch history when the server rejects the commit) and checks out the `llama.cpp` submodule at
   the pinned commit. It forces `core.autocrlf=false` and `core.eol=lf` in that checkout.
2. Resets the checkout and applies every patch in `scripts/wllama/patches/` with `git apply`. A
   patch that no longer matches aborts the build with the patch name.
3. Installs the wllama dev dependencies with `npm ci` and bundles the library with tsup.
4. Runs the upstream Docker recipe (`scripts/docker-compose.yml` in the checkout) with
   `emscripten/emsdk:4.0.20`: WebGPU enabled, JSPI build, plus the compat (asyncify) build.
5. Writes the worker and module scripts and a manifest, then stages the result in
   `vendor/wllama/.dist-staging` and moves it into `vendor/wllama/dist/` only after every file
   passed the size checks.
6. Copies the runtime files and the manifest to `public/vendor/wllama/`, where WXT packages them.

`pnpm build:wllama` deletes `public/vendor/wllama/` before it starts, so a failed build never leaves
the previous wasm in the next package. `pnpm verify:wllama` checks `wllama-build.json` against both
the dist and the public copies (byte count, SHA-256, extra or missing files) and is part of
`pnpm build` and `pnpm zip`. `pnpm test:e2e` builds a separate package that translates in the page
and does not require the wasm artifacts.

## Outputs

`vendor/wllama/dist/` holds the build, `public/vendor/wllama/` holds the copy that WXT packages.
Both directories are gitignored; a release build must run `pnpm build:wllama` first. The source
checkout lives in `vendor/wllama/.checkout`, a dot directory, so workspace tools skip the upstream
examples and their Svelte configs.

| File                       | Purpose                                        |
| -------------------------- | ---------------------------------------------- |
| `wllama.js`                | ESM library bundle loaded by the extension     |
| `wllama.wasm`              | WebGPU/JSPI build of llama.cpp                 |
| `wllama-worker.js`         | Static classic worker entry, no `blob:` URL    |
| `wllama-module.js`         | Emscripten glue loaded by the worker           |
| `wllama-pthread.js`        | Pthread entry, passed as `mainScriptUrlOrBlob` |
| `wllama-compat.wasm`       | Compat (no JSPI, no memory64) wasm             |
| `wllama-compat-module.js`  | Compat glue                                    |
| `wllama-compat-pthread.js` | Compat pthread entry                           |
| `wllama-build.json`        | Pinned inputs, patch and file hashes           |

`src/engine/wllama/` is the typed loader. It builds the asset URLs from
`chrome.runtime.getURL` and passes them to the patched `Wllama` constructor; it contains no model
logic. `loadWllamaModule` refuses to import a URL outside the extension origin, so the only dynamic
import in the package points at `vendor/wllama/wllama.js`.

The library bundle is shipped unminified so its hash can be reviewed against the pinned source.
`wllama-build.json` records the byte size of every artifact and `pnpm zip` prints the packed size,
so enabling `tsup --minify` later can be measured against the current numbers.

## The MV3 patches

MV3 extension pages cannot create workers from `blob:` URLs and cannot use `eval`. The two patches
cover both places where wllama used a Blob:

- `0001-static-worker-script.patch` replaces the Blob worker with a packaged script. Run options
  travel in the worker URL query string, and the module URL is passed to the worker as a string
  instead of a Blob.
- `0002-packaged-asset-paths.patch` lets `AssetsPathConfig` point at packaged worker, module,
  pthread and compat files, so the library never fetches its worker or wasm from a CDN. A custom
  `setCompat()` value still wins when it is set; the packaged compat files are used only when no
  custom value is set and the runtime needs compat mode.

The worker loads its glue with `importScripts`, and the emscripten pthread entry is a static file
under the extension origin. No code is fetched at runtime.

## The CPU kernel patch

Emscripten's CMake toolchain reports the processor as `x86`. ggml-cpu does not read that as wasm,
so without a patch it builds `GGML_CPU_GENERIC`, the scalar fallback, and never compiles the wasm
SIMD dot products in `ggml-cpu/arch/wasm/quants.c`.
`0003-wasm-simd-cpu-kernels.patch` passes `-DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm32` to both builds.
The build fails if the SIMD object file is missing, so the flag cannot drop out unnoticed.

On a 32-thread Windows desktop with 8 CPU threads, the patch raised the mean decode rate of the
`quant.ts` samples from 35.5 to 43.1 tokens/s for Q4_K_M. The full `long-article` page fell from
67.2 s to 56.7 s on the CPU tier (one sample each). The WebGPU tier does not change.

## The WebGPU encoding patch

On the WebGPU tier, a token's cost was mostly command encoding rather than GPU work. Each decode
step encodes the same few hundred dispatches over the same buffers, and ggml-webgpu created a new
bind group and issued a separate `WriteBuffer` for every dispatch. In a browser each call is
serialized to the GPU process. A trace of 71 tokens on an RTX 4090 showed the worker idle about
60% of the time and about 33 command-buffer flushes per token.

`0004-webgpu-reuse-bind-groups.patch` changes `llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp`:

- Bind groups are cached by pipeline and entries. The cache is cleared when a buffer is freed,
  because a later buffer can reuse the freed handle's address.
- Kernel parameters are staged on the host and uploaded with one `WriteBuffer` before each submit.
- A matrix product with more than four rows used to run in the tiled matrix shader, which took 87%
  of the GPU time of a batched decode. It now runs through the vector shader in batches of four
  columns, which share each read of the weights.
- The backend's synchronize no longer waits for the queue. The tensor read that follows waits for
  the same work, and the extra round trip took most of a decode step.

Bind group reuse and the single upload leave the GPU work unchanged, and the `quant.ts` samples
translate to identical text. On an RTX 4090 they cut the median time per token from about 14 ms to
9.5 ms, and each bench page finished 16–32% sooner (three samples each).

## The request state patch

`0005-disable-prompt-cache.patch` removes two costs of running several slots:

- `cpp/wllama-context.h` turns the server's prompt cache and context checkpoints off. Each read a
  slot's cells back from the GPU, which took over a second per request and about 0.4 s per prefill
  batch on WebGPU.
- `llama.cpp/tools/server/server-context.cpp` clears a finished request's cells when that request
  asked for no prompt reuse. Cells left by idle slots widened every attention step of the requests
  that were still running.

With both patches the WebGPU tier runs in waves: sixteen slots on an NVIDIA GPU with the integer
shaders (packed dot product), four otherwise. On an RTX 4090, `long-article` went from about 19.8 s
on v1.0.1 to about 2.9 s (six runs each). Against a single slot, 38 to 39 of its 44 blocks stayed
the same; the others differ in word choice, and batched output varies slightly between runs.

The patch lives inside the llama.cpp submodule, so the build resets the submodule's files before
it applies the patches.

## Compatibility builds

`needCompat()` (missing JSPI or memory64) selects the compat files automatically. The compat build
is slower, but it keeps the extension usable on older Chrome versions. Chrome with JSPI uses the
default wasm and the fast path. Set `SKIP_COMPAT=1` to build only the default target and to skip
the compat files in the manifest; the default (unset) builds and packages both.

## Reproducibility

The wllama commit, the `llama.cpp` submodule commit, the `emscripten/emsdk` tag (`4.0.20`, with an
`-arm64` variant on Apple Silicon) and the patches are pinned. The emsdk tag and the Dawn release
are fetched from registries, and the upstream Docker recipe runs `apt update`, so the wasm is not
bit-for-bit reproducible. Instead, `wllama-build.json` records the inputs (emsdk image, Dawn tag,
Node, tsup, the SHA-256 of the checkout `package-lock.json`) and the SHA-256 of every output, and
`pnpm verify:wllama` compares the packaged files with that manifest. The checkout in
`vendor/wllama/.checkout` is only a cache; delete it to force a fresh clone.

`pnpm wllama:check` fetches the pinned source, checks the submodule commit and runs
`git apply --check` for every patch. Pull requests that change the extension run that check.
The zip, the zip contents check, and the worker smoke test run on pushes to `main`, on `v*` tags,
from a manual run, when `scripts/wllama` changes, and when the package action or
`.github/workflows/ci.yml` changes. Tag pushes run `.github/workflows/release.yml`, which calls the
same package action. A pull request that only edits that workflow does not build the zip. Those
runs restore `vendor/wllama/dist` from the Actions cache when the
pin, patches, build scripts, and emsdk tag are unchanged. The emsdk image is cached the same way. A
cache miss compiles with `emscripten/emsdk:4.0.20` and then saves both caches. The job uploads
`chrome-mv3-zip` (the store zip from `pnpm zip`) and `chrome-mv3` (the unpacked extension), and
fails if the zip is missing or smaller than 1 MiB.

## Troubleshooting

- `Docker Compose v2 is required` or `The Docker daemon is not reachable`: start Docker Desktop and
  rerun.
- `does not apply to wllama @d275dac`: the pinned source or the patches changed; regenerate the
  patch with `git diff` in the checkout.
- Patches apply on Linux but not on a Windows host with `core.autocrlf=true`: the script sets
  `core.autocrlf=false` in the checkout before fetching and checks the patch targets out as LF. A
  checkout created by an older version of the script can still hold CRLF files; delete
  `vendor/wllama/.checkout` and retry.
- An old `vendor/wllama/checkout` directory is no longer used. Delete it so `svelte-check` does not
  crawl the upstream Svelte examples.
- On Apple Silicon and Windows on ARM the script uses the `4.0.20-arm64` emsdk tag.
