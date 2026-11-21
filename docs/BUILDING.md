# Building the bundled wllama

The extension runs PLaMo 3 Translate with a pinned wllama build. The published npm package
(`@wllama/wllama` 3.8.1) cannot load the PLaMo 3 tokenizer, so the extension ships its own build of
[ngxson/wllama](https://github.com/ngxson/wllama) at commit `d275dac` (llama.cpp `5aeac37`,
2026-10-18) with two MV3 patches, one build-flag patch, two run-time patches, a Dawn
download retry, and two WebGPU adapter/device patches.

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
2. Resets the checkout and applies every `*.patch` in `scripts/wllama/patches/` (not
   `patches/optional/`) with `git apply`. A patch that no longer matches aborts the build with the
   patch name. `0007-firefox-webgpu-kick.patch` stays optional and off until a Firefox GPU
   measurement confirms it; see `src/engine/wllama/firefox-webgpu-kick.ts`.
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

With both patches the WebGPU tier ran in waves: sixteen slots on an NVIDIA GPU with the integer
shaders (packed dot product), four otherwise. The sixteen-slot path now starts one job, expands
to four and then sixteen as each stage starts producing output, and refills individual free slots
after that. It does not start all sixteen jobs at once. Four-slot configurations keep their waves.

A small foreground batch (up to five reader-visible bodies) is kept apart after the initial ramp:
background work can fill places the foreground left among the first four starts, but does not
immediately take slots that foreground jobs free. Larger foreground batches share the full width
after the ramp. Once the small foreground batch finishes, the hold lifts for the rest of that busy
period. Free-slot refill then avoids waiting for the longest job in a wave before starting more
work.

This refill path requires `0013-get-result-pending-first.patch` and
`0014-webgpu-flash-attn-skip-masked-tiles.patch` in addition to `0005`. The first returns a waiting
result before decoding another step; the second skips fully masked flash-attention tiles. Together
they let a prompt join the running sequences at a cost of about one step. See
`refillsFreeSlots` in `src/engine/in-browser/backend.ts`.

On an RTX 4090, `long-article` went from about 19.8 s on v1.0.1 to about 2.9 s (six runs each).
Against a single slot, 38 to 39 of its 44 blocks stayed the same; the others differ in word choice,
and batched output varies slightly between runs.

The patch lives inside the llama.cpp submodule, so the build resets the submodule's files before
it applies the patches.

## The WebGPU adapter and device retry

`0007-webgpu-adapter-device-retry.patch` changes how ggml-webgpu picks an adapter and a device.
The pinned llama.cpp required `shader-f16` plus every advertised adapter limit, then
`GGML_ASSERT` on a failed `requestDevice`. A failed device, or a WGSL compile after a
retry that dropped `subgroups`, aborted WASM and left the model on the CPU with only
"WebGPU could not load the model". The patch:

- Tries `powerPreference` high-performance, then default, then low-power, and keeps a
  `shader-f16` adapter when one exists ([ggml-org/llama.cpp#21744](https://github.com/ggml-org/llama.cpp/pull/21744),
  [#23844](https://github.com/ggml-org/llama.cpp/issues/23844)). Windows Chrome ignores
  `powerPreference` ([crbug 369219127](https://issues.chromium.org/issues/369219127));
  the extra tries stay harmless. Settings suggests `chrome://flags/#force-high-performance-gpu`
  when the adapter looks integrated.
- Retries `requestDevice` while **keeping `subgroups` whenever the adapter has it**, only
  lowering limits: adapter-max → 2 GiB−4 cap → default limits. A last-resort `shader-f16`
  only device then re-derives `supports_subgroups` from `device.HasFeature` so the
  workgroup-reduction shaders compile (ggml's `USE_WORKGROUP_REDUCTION` path).
- Does not assert. `device_count` is 1 only when a device exists. Logs `device ready`,
  `device features`, and `device limits` so Sakutto can show the granted stage.
- Never guesses a subgroup size. Unknown or zero `subgroupMinSize`/`MaxSize`
  disables subgroups and uses ggml's workgroup-reduction shaders. A wrong
  `MAX_SUBGROUP_SIZE` (for example 64 on wave32 NVIDIA) silently mistranslates.
- After `requestDevice`, runs a cheap known-answer probe (workgroup add plus a
  `subgroup_size` readback). A size mismatch drops subgroups in-process; an add
  mismatch disables WebGPU. The log line
  `ggml_webgpu: correctness probe: ok subgroups=… subgroup_size=… add=… ms=…`
  is copied into Settings diagnostics.

`0008-webgpu-debug-profile.patch` copies `globalThis.__SAKUTTO_WEBGPU_DEBUG__` into the worker.
The offscreen document often has no `chrome.storage`; the service worker reads
`chrome.storage.local.sakuttoWebGpuDebug` and puts it on the offscreen URL (and answers
`engine:webgpu-debug`). Profiles, after a wllama rebuild:

- `amd-rdna3` / `intel-arc` — cap C++ buffer limits to 2 GiB−4 (Chrome on NVIDIA already
  reports those, so this may not reject `requestDevice`). They do **not** spoof
  subgroup size: a wrong min/max silently mistranslates, so shaders and the
  diagnostic keep the adapter's reported range. Typical RDNA3 is 32–64 and Arc
  16–32; those figures are documentation only.
- `reject-max-limits` — fail adapter-max `requestDevice` so the capped/default ladder runs
- `no-f16` — disable the WebGPU backend as if the adapter lacked `shader-f16`

Reload the extension (or recreate the offscreen document) after setting the flag.

**The owner must rebuild wllama** after these patches: `pnpm build:wllama` then
`pnpm verify:wllama`. Until that runs, the packaged wasm is still the previous build and AMD
device retries are not in the worker.

## 2026-11-09: AMD/Intel fallback and subgroup fail-safe

Owner retest on Windows, Chrome, RTX 4070 Ti SUPER, wllama rebuilt. This is not a
`pnpm bench:live` fixture run. The page was four paragraphs plus a heading; every
successful translation was 149 characters and identical to `off`.

### What was wrong

1. **Subgroups dropped on retry while shaders still used them.** A later
   `requestDevice` (capped or default limits) omitted the `Subgroups` feature, but
   ggml still compiled WGSL with `enable subgroups`. Chrome rejected
   `extension 'subgroups' is not allowed`, WASM aborted, and the model ran on CPU.
2. **`gpuEvidence` misread intermediate failures.** A failed adapter-max
   `requestDevice` looked fatal even when a later stage succeeded. After the
   correctness probe, a `device ready` line before `correctness probe failed`
   looked like success, so status stayed `backend=webgpu`, `tier=g`,
   `gpuFallback=false` while the model ran on CPU at 16 parallel (3.5–5.3 s
   instead of ~2.9 s with CPU settings).
3. **`subgroupMaxSize == 0` was guessed as 64.** Shader specialization then
   assumed wave64 on 32-wide NVIDIA hardware. The `subgroup-64` debug overlay did
   the same on purpose. WebGPU stayed engaged at 16 parallel with no error, but
   the text was garbage (shorter than 149 characters, e.g. 「子供たちは 川を 運ぶ。」).
4. **The debug flag did not reach the offscreen document.** Offscreen has
   `chrome.runtime` but not `chrome.storage`, so `sakuttoWebGpuDebug` in
   `chrome.storage.local` never reached ggml.

### What fixed each

| Failure                                                           | Fix                                                                                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subgroups dropped on retry                                        | Retry ladder keeps `Subgroups` whenever the adapter has it; `device.HasFeature` re-derives shader caps. Last-resort f16-only uses `USE_WORKGROUP_REDUCTION`.           |
| Intermediate `Failed to get a device (…)` treated as fatal        | `gpuEvidence` only treats _final_ failures as missing GPU (`after retries`, no adapter, no f16, probe failed).                                                         |
| Probe failure after `device ready` left WebGPU/16-parallel status | Check final failure, especially `correctness probe failed`, **before** `sawDeviceReady`. That path is `gpu-unavailable` and falls back with CPU slots.                 |
| Guessed or forced subgroup size 64                                | Never guess. Unknown/0 disables subgroups. No `subgroup-64` debug mode.                                                                                                |
| Silent mistranslation in general                                  | Known-answer probe after `requestDevice` (workgroup add = 136, plus `subgroup_size` readback). Size mismatch drops subgroups in-process; add mismatch disables WebGPU. |
| Debug flag missing in offscreen                                   | Patch `0008` copies `__SAKUTTO_WEBGPU_DEBUG__` into the worker. The service worker puts the profile on the offscreen URL and answers `engine:webgpu-debug`.            |

NVIDIA first try is unchanged: adapter-max + optional features, 16 parallel when
`fastBatches`.

### Measurements (2026-11-09)

Machine: Windows, RTX 4070 Ti SUPER, Chrome. Page: 4 paragraphs + heading.
Output: 149 characters, identical to `off` in every mode that produced a
translation. Probe cost is 5–22 ms (89 ms on the very first run).

| Profile                              | Runtime                         |                   Probe |  Load | Translate |
| ------------------------------------ | ------------------------------- | ----------------------: | ----: | --------: |
| `off`                                | WebGPU 16 parallel, adapter-max | ok, subgroup 32, 9.8 ms | 2.9 s |    0.82 s |
| `reject-max-limits`                  | WebGPU, capped-limits           |                  6.2 ms | 2.9 s |    0.86 s |
| `amd-rdna3`                          | WebGPU 4 parallel               |                  8.3 ms | 2.9 s |    0.69 s |
| `intel-arc`                          | WebGPU                          |                  9.3 ms | 4.9 s |    0.86 s |
| `no-f16`                             | CPU 8 threads                   |                       — | 2.9 s |     2.9 s |
| simulated subgroup size 0            | WebGPU, subgroups disabled      |                  5.4 ms |     — |    0.79 s |
| spoofed 64–64 range                  | probe drops subgroups           |                       — |     — |    1.15 s |
| forced probe failure (add 152 ≠ 136) | CPU; output still correct       |                  failed |     — |         — |

`amd-rdna3` / `intel-arc` cap C++ buffer limits only. They do not spoof subgroup
size; a fake 32–64 range would either lie in the diagnostic or risk the silent
mistranslation above.

### Remaining unknowns

Not yet verified on real Radeon hardware (RX 7800 XT / RDNA3). Chrome on this
NVIDIA machine already reports 2 GiB−4 adapter limits, so `amd-rdna3` may not
reject `requestDevice`. A Radeon-only Dawn/D3D12 mismatch, or a WGSL/pipeline
failure after a device exists, is still possible for issue #48.

## Wide subgroups and flash-attn vec

`0009-webgpu-wave64-flash-attn.patch` is aimed at a Radeon iGPU of the Vega
generation (GCN, 64-lane wavefronts). It has not been run on that GPU. What
follows is what the pinned shaders do, and what this tree changed.

### What the shaders do

Decode (query length under 20) uses `flash_attn_vec_split.wgsl`. Prefill of a
longer prompt already uses `flash_attn_tile.wgsl`. In the vec shader the first
P\*V `subgroupShuffleDown` delta is `subgroup_size / 2`. With `D_SPLIT` 4 that
delta is 32 on a 64-wide subgroup, and the Q\*K broadcast can read a lane up
to `subgroup_size - D_SPLIT`. The tile shader reduces with scalar
`subgroupAdd` / `subgroupMax` and does not shuffle across that boundary.
llama.cpp master, as of this writing, still has that vec reduction.
`#25418` (2026-07-08) only retuned `D_SPLIT`; it is already in the pin
(`5aeac37`, 2026-10-18) and does not remove the wide shuffle. A newer wllama
does not contain a Vega fix for this.

The same shape of failure is already reported around AMD D3D12 subgroups:
scalar f32 `subgroupAdd` / `subgroupMax` can be fine while a wide shuffle or a
vector f16 reduction is not (ONNX Runtime #34078 was `subgroupMax` on
`vec4<f16>` on RDNA1; the scalar f32 case there was fine). Treating a GCN
wave as 32-wide has also produced an endless token loop on the Vulkan backend
(llama.cpp #21556). None of those reports were reproduced on the Vega iGPU
this change is for. The link is the shader, not a measurement.

A probed subgroup size of 32 leaves the vec path on. That is the NVIDIA run
from 2026-11-09 (`subgroup_size` 32). A device whose probed size is 32 and
whose advertised maximum is higher still uses vec; if a later dispatch is
64-wide, the repetition check below is what sends that request to the CPU.

### What the patch changes

After the existing uint32 add, the probe also runs:

- an f16 workgroup reduction, known answer 72
- one f16 dot (`dot(vec4(1,2,3,4), vec4(1,1,1,1))`), known answer 10
- when subgroups are on, `subgroupAdd` of the lane ids, known answer
  `N*(N+1)/2`

A mismatch disables WebGPU, same as the uint32 add. When the probed size is
above 32, vec flash-attn is turned off even if a single `subgroupShuffleDown`
by 32 returns 33. That result is only logged (`wide_shuffle=ok|bad`). The
log line keeps the old prefix and adds `f16=… matmul=… sgadd=… wide_shuffle=…
vec=on|off`. If four subgroups do not fit in `maxComputeInvocationsPerWorkgroup`
(256 invocations are required for a subgroup of 64), the tile shader would
return without writing, so the probe disables WebGPU instead.

### What was not measured

No Radeon ran this patch. The wasm in the tree is not rebuilt by the tests;
CI rebuilds it when the patch changes. The f16 and subgroup probes have not
been executed on a GPU here. If one of those shaders fails to compile, the
existing ladder disables WebGPU and the model loads on the CPU. That is
fail-closed, and it is not a result from a Radeon.

Switching decode from the vec shader to the tile shader on a subgroup wider
than 32 was not timed. Prefill of a prompt whose query length is already 20
or more was already on the tile shader, so the change is the decode of each
new token. The 2026-11-09 numbers are a different change (subgroups fully
disabled, workgroup reduction, still WebGPU): about 0.79 s versus 0.82 s with
subgroups, on an RTX 4070 Ti SUPER. They do not describe the tile path on Vega.

### Repetition check

Independently of the wasm, a completion that is eight or more copies of the
same 1–8 character piece, covering at least 80% of a string of 16 characters
or more, is treated as a collapsed kernel when the source is not itself a
laugh, chant, or run of marks, and generation hit `maxTokens` (or the output
is far longer than the source). Tokens stream immediately. If the finished
string is broken, the painted prefix is replaced and the piece is retried on
CPU; broken text is not cached. A warm-up of "Hello." (at most 16 tokens)
uses the same check and leaves WebGPU. The cache key is `v2` and includes
the backend. A short string such as 「こんにちは。」 twice is under the
length cutoff and is left alone.

## The mat-vec workgroup size

`0010-webgpu-mat-vec-workgroup.patch` changes how many threads the k-quant integer mat-vec shader
starts. Patch `0004` sends batched decodes through that shader.

The shader runs in workgroups of 256 threads, and a thread reads 16 values of a row. A row of K
values has work for K / 16 threads. The others read nothing and only take part in the reduction at
the end. Most matrices of PLaMo 3 Translate have rows narrower than 256 × 16 values, so most
dispatches started 256 threads where 96 to 192 had work.

### What the patch changes

The pipeline key carries a workgroup size. For a Q4_K or Q6_K matrix on NVIDIA with subgroups, the
size is K / 16 rounded up to whole subgroups, and at most 256:

| Model | K     | Matrices                       | Threads before | Threads after |
| ----- | ----- | ------------------------------ | -------------: | ------------: |
| 0.8B  | 1536  | `attn_qkv`, `ffn_up`, `output` |            256 |            96 |
| 0.8B  | 2048  | `attn_output`                  |            256 |           128 |
| 0.8B  | 6144  | `ffn_down`                     |            256 |           256 |
| 2B    | 2560  | `attn_qkv`, `ffn_up`, `output` |            256 |           160 |
| 2B    | 3072  | `attn_output`                  |            256 |           192 |
| 2B    | 10240 | `ffn_down`                     |            256 |           256 |

The shader source is not changed, only its `WG_SIZE` define. A thread reads the same block as
before, and whole subgroups are kept, so every sum is added in the same order.

Without subgroups the shader reduces by folding the workgroup in halves, which drops part of the
sum when the size is not a power of two. A build of this patch without the subgroup condition, run
with the `subgroups` feature hidden from the wasm, used 96 threads there, and every request failed
with invalid UTF-8 in the output. That path keeps 256 threads. So do other vendors and other quant
types.

### Measurements (2026-11-16)

RTX 4090, subgroup size 32. Both builds are this tree's patched sources, with and without `0010`.

The translations are the same text. `long-article` was translated in a bare wllama page
(Chromium 156), two to four rounds per build, and each round was compared with the same round of
the other build. All 44 blocks matched with sixteen, four and one slot, for the 0.8B and the 2B
model. They also matched with the `subgroups` feature hidden, where the patch must change nothing
(0.8B with sixteen and four slots, 2B with sixteen).

`pages-run.ts --mode live --tier g` (Chromium 158, 0.8B, extension v1.6.1), the builds alternated
over three launches each. The numbers are the median full-page time of the six samples that are
not the first of a launch:

| Page                             | Before (ms) | After (ms) | Change |
| -------------------------------- | ----------: | ---------: | -----: |
| `long-article`                   |        2700 |       2388 | −11.6% |
| `first-paragraph-then-long-tail` |        2213 |       1976 | −10.7% |
| `many-cards`                     |        1300 |       1138 | −12.4% |
| `single-long-paragraph`          |        1376 |       1326 |  −3.7% |
| `model-card-sidebar`             |        1076 |        950 | −11.7% |
| `mixed-ui`                       |        1164 |       1126 |  −3.2% |
| `headline-in-header`             |        1926 |       1726 | −10.4% |
| `late-mount-spa`                 |        2013 |       1988 |  −1.2% |

Three earlier runs of the same comparison gave 4% to 7% for `single-long-paragraph`, 3% to 6% for
`mixed-ui` and 0.0% to 2.4% for `late-mount-spa`. Read the last as no change, and the other two as
a few percent that moves between runs.

The 2B model was only run in the bare page: with sixteen slots `long-article` went from 4.08 s to
3.72 s (−8.8%, twelve alternated pairs, the faster build in all twelve).

Each new workgroup size is one more pipeline to create. In the bare page, which starts from an
empty profile every time, the warm-up after a model load took about 0.15 s longer (144 → 298 ms
for 0.8B, 182 → 340 ms for 2B). The first text of the page after it did not move, and that first
page already finished sooner. In the extension with a returning profile, the time from the options
page opening to `plamoReady` was about 2.0 s either way (medians of 1984 and 1994 ms over six
launches each).

With the browser's GPU process crashed in the middle of `long-article`, both builds finished that
page and the next two on WebGPU (two runs each).

### What was not measured

- Any GPU other than the RTX 4090. That is why other vendors are left alone. Another NVIDIA card
  takes the same path, but none was run.
- The Docker build. The wasm measured here was built on Windows with emscripten 4.0.20 from the
  same patched C++ sources. CI rebuilds it.
- The 2B model inside the extension. The page bench loads the 0.8B model.
- Workgroups of 32 and 64 threads, for rows of 1024 values or fewer. The code allows them, but no
  model in the catalog has such rows.
- Firefox.

## The greedy sampling path

`0011-greedy-sample-scan.patch` changes `llama.cpp/common/sampling.cpp`. It is CPU work between
two decode steps, so it does not depend on the GPU.

Sakutto sends `temperature: 0`. llama.cpp then ends the sampler chain in its greedy sampler, and no
sampler before it can change which token has the largest logit. The chain still ran in full for
every token: `common_sampler_sample()` built an array with one candidate per vocabulary entry, and
`top_k` partially sorted it. PLaMo 3 Translate has 107520 entries, so that is 1.3 MB written and
then scanned for each token of each sequence. The server's own timers (`DEBUG_TIMINGS` in
`server-context.cpp`, a diagnostic build) put it at 0.19 ms per token. For sixteen sequences that
works out to about 3 ms per step, next to a decode that the same timers put at about 9 ms.

### What the patch changes

`common_sampler_sample()` first asks whether the chain can only return the token with the largest
logit. If so, it scans the logits for that value and returns its token. That is the case only when
all of these hold:

- no grammar, reasoning budget, backend sampling, mirostat, `n_probs`, logit bias or suppress
  tokens
- the chain ends in the greedy sampler, by the same test as in `common_sampler_init()`
- every sampler in the list keeps the largest logit with the settings in use: `top_k`, `top_p`,
  `min_p` and `top_n_sigma` always do, `penalties`, `dry`, `typical_p` and `xtc` only while they
  are switched off, and `temperature` only at 0 or below without `dynatemp`

Any other request takes the old path unchanged. A token taken on the new path does not pass
through the chain, so the chain's own counters (`llama_perf_sampler`) do not count it.

The token is the one the chain would pick. The one case that can differ is two tokens that share
the largest logit exactly: the scan returns the lower id, and the order the chain leaves after its
partial sort is not specified.

### Measurements (2026-11-16)

RTX 4090. The builds are this tree's patched sources with `0011` alone, with `0010` alone, with
both, and with neither.

The sampler took 0.07 ms per token after the change, with sixteen and with four slots.

The translations are the same text. With the same round-by-round comparison as for `0010`, all 44
blocks of `long-article` matched with sixteen, four and one slot, for the 0.8B and the 2B model,
with the `subgroups` feature hidden, and with the model on the CPU. Requests that must keep the old
path also gave the same text as before: a temperature of 0.7 with a seed, `n_probs`, and a
temperature of 0.7 ahead of `top_k: 1`.

In the bare wllama page with sixteen slots, `long-article` went from 2.23 s to 2.09 s with `0011`
alone (−6.1%) and from 2.25 s to 1.79 s with both patches (−20.0%), the faster build in all sixteen
alternated pairs each time.

`pages-run.ts --mode live --tier g` (Chromium 158, 0.8B, extension v1.6.1), the same run as the
table for `0010`:

| Page                             | Before (ms) | `0011` (ms) | Change | Both (ms) | Change |
| -------------------------------- | ----------: | ----------: | -----: | --------: | -----: |
| `long-article`                   |        2700 |        2513 |  −6.9% |      2214 | −18.0% |
| `first-paragraph-then-long-tail` |        2213 |        2076 |  −6.2% |      1850 | −16.4% |
| `many-cards`                     |        1300 |        1226 |  −5.7% |      1076 | −17.2% |
| `single-long-paragraph`          |        1376 |        1326 |  −3.6% |      1251 |  −9.1% |
| `model-card-sidebar`             |        1076 |        1025 |  −4.7% |       888 | −17.4% |
| `mixed-ui`                       |        1164 |        1114 |  −4.3% |      1064 |  −8.6% |
| `headline-in-header`             |        1926 |        1788 |  −7.1% |      1626 | −15.6% |
| `late-mount-spa`                 |        2013 |        1988 |  −1.2% |      1950 |  −3.1% |

For `0011` alone the changes under 5% are too small for this bench to call, although each page was
below the unpatched build in all three launches.

With the browser's GPU process crashed in the middle of `long-article`, the build with both
patches finished that page and the next two on WebGPU, as the unpatched build did (two runs each).

### What was not measured

- Any other machine. The saving is CPU time per token, so it should not depend on the GPU, but
  only this PC was timed.
- A gain on the CPU tier. One page on the CPU took 32.9 s without and 30.4 s with `0011`, and with
  `0010` also applied 30.5 s without and 30.6 s with it, one run each. That shows nothing either
  way.
- Speculative decoding. It reads the candidate list after sampling, and on this path the list
  holds only the chosen token. Sakutto passes no draft model, and the sampler of a draft keeps ten
  candidates, so it does not take this path. That is from reading the code, not from a run.
- The compat build, the Docker build and Firefox, as for `0010`.

## Reading back the chosen token

`0012-backend-argmax.patch` changes what a decode brings back from the GPU when every sequence
samples greedily. It builds on `0011`.

A decode ends with the logits of every sequence in a GPU buffer, and llama.cpp copies them to the
CPU: 107520 floats, 430 kB, for each sequence of PLaMo 3 Translate. With sixteen sequences that is
6.9 MB for every token step, and the greedy path of `0011` then scans each row for one index.

### What the patch changes

`llama_set_argmax_only()` makes a decode end its graph in an argmax over the logits and read back
one token id per sequence. `llama_get_argmax_ith()` returns it, and `common_sampler_sample()` asks
there before it scans the logits.

The server sets it before every decode, and only when each slot that is processing would take the
largest logit: the test of `0011` on the slot's sampler, a task that samples at all, and no draft
model. One slot that needs its logits switches the whole decode back, because the logits of a
decode are one tensor. A graph built for one setting is not reused for the other.

A model whose output layer is on the CPU keeps its logits. They are in host memory there and
nothing would be saved. For a row whose logits were not read back, `llama_get_logits_ith()` returns
NULL and logs an error, instead of the floats an earlier decode left in the buffer. No caller in
the server reaches that: `n_probs`, grammars and the other users of the logits fail the test above.
The candidate that `common_sampler_sample()` records for such a token has the logit 0, because
the value never left the GPU.

The WebGPU backend already had an argmax shader, which this model's graph did not use. It
returned the highest index among equal values, and -1 for a row with no value above -1e9. It now
returns the lowest index among equal values, as the scan of `0011` does, and 0 instead of -1. On
another backend the choice among equal logits is that backend's.

### Measurements (2026-11-17)

RTX 4090. The builds are this tree's patched sources up to `0009`, `0011`, `0012` and `0013`.

The translations are the same text. In a bare wllama page (Chromium 156) `long-article` was
translated one to four rounds per build, and each round was compared with the same round of the
unpatched build. With `0010` to `0013` applied all 44 blocks matched with sixteen, four and one
slot, for the 0.8B and the 2B model, with the `subgroups` feature hidden, with the model on the
CPU, and for requests that keep their logits: `n_probs`, a temperature of 0.7 with a seed, and
the same ahead of `top_k: 1`. In the extension the eight bench pages gave the same 262 blocks as
the unpatched build, in two passes over the pages and in two launches of each build.

In the bare page with sixteen slots `long-article` went from 1.79 s to 1.54 s against the build
with `0010` and `0011` (−14.2%), and from 2.22 s to 1.53 s against the unpatched build (−31.1%),
the faster build in all sixteen alternated pairs each time. `0013` is 0.02 s of that.

`pages-run.ts --mode live --tier g` (Chromium 158, 0.8B, extension v1.6.2), the builds alternated
over three launches each, medians of the six samples that are not the first of a launch. "All
four" is `0010` to `0013`:

| Page                             | Unpatched (ms) | `0010` + `0011` (ms) | All four (ms) | From `0011` | From unpatched |
| -------------------------------- | -------------: | -------------------: | ------------: | ----------: | -------------: |
| `long-article`                   |           2675 |                 2250 |          2014 |      −10.5% |         −24.7% |
| `first-paragraph-then-long-tail` |           2213 |                 1850 |          1676 |       −9.4% |         −24.2% |
| `many-cards`                     |           1288 |                 1076 |           976 |       −9.3% |         −24.2% |
| `single-long-paragraph`          |           1376 |                 1276 |          1213 |       −4.9% |         −11.8% |
| `model-card-sidebar`             |           1063 |                  900 |           826 |       −8.3% |         −22.3% |
| `mixed-ui`                       |           1151 |                 1076 |          1026 |       −4.6% |         −10.9% |
| `headline-in-header`             |           1912 |                 1638 |          1538 |       −6.1% |         −19.6% |
| `late-mount-spa`                 |           2001 |                 1951 |          1926 |       −1.3% |          −3.7% |

`long-article` on its own, twelve such samples per build: 2476 ms unpatched, 2026 ms with `0010`
and `0011`, 1801 ms with `0012` added, and 1801 ms with all four.

The argmax pipeline is one more to create. The warm-up after a model load took 300 ms with all
four patches and 293 ms without `0012` and `0013` (medians of three loads; 143 ms unpatched, see
`0010`).

With the browser's GPU process crashed in the middle of `long-article`, the build with all four
patches finished that page and the next two on WebGPU, as the unpatched build did (two runs
each).

### What was not measured

- Any GPU other than the RTX 4090, the Docker build and Firefox, as for `0010`.
- Two tokens with exactly the same largest logit. The shader's order was read, not provoked.
- A backend other than WebGPU. The patch is not specific to it, but this build has no other.

## Results that are already waiting

`0013-get-result-pending-first.patch` changes `get_result` in `cpp/wllama-context.h`, the action
wllama's JS calls in a loop to stream a completion.

Each call ran the server loop once, which decodes one token for every slot, and then returned at
most one result of the request it was called for. With sixteen requests streaming, sixteen calls
decoded sixteen tokens for each request and handed over one of each. The rest waited in the
queues. Text reached the page later than it was decoded, and so did the end of a request: the
server had finished it and freed its slot, and the caller saw that only after it had drained
what was queued.

### What the patch changes

A call first takes a result that is already waiting. It runs the loop only when nothing is
waiting and the request has not ended.

The decodes are the same, so requests that start together and are awaited together take as long
as before. What changes is when each result is seen.

### Measurements (2026-11-17)

RTX 4090, the same builds and pages as above.

The extension starts its requests in groups and waits for a whole group. There `long-article`
took 1801 ms with and without `0013`, and its first visible text came at 151 ms instead of 176 ms
(medians of twelve samples each).

In the bare page, with each request started as soon as another had ended, sixteen at a time,
`long-article` took 2.97 s to 3.06 s without `0013` and 1.43 s to 1.46 s with it (two warm rounds
each).

The patch does not change what a decode computes. Where it changes the moment a caller starts its
next request, the requests share decode steps differently, and a few blocks come out in other
words, as they do between two rounds of one build. In the bare-page run just described, 5 to 7 of
the 44 blocks differed from the build without `0013`. In the extension's own order the texts did
not change: the 262 blocks of the eight pages matched the unpatched build.

### What was not measured

- The other GPUs, the Docker build and Firefox, as above.
- A caller that stops polling one request while it keeps polling others. The loop then runs for
  the others as before, and the unpolled request keeps its slot until it is cancelled.

## Masked tiles in flash attention

`0014-webgpu-flash-attn-skip-masked-tiles.patch` changes `flash_attn_tile.wgsl`, the flash
attention shader for batches of twenty tokens or more on a GPU with subgroups. Prompts are read
on it. Smaller batches take the vec path described under "Wide subgroups and flash-attn vec".

The shader works through the KV cache in tiles of up to 64 cells. For each tile it copies K and V
into workgroup memory and scores every cell for each of the four query rows of the workgroup,
and only then adds the mask. All sequences share one cache (`kv_unified`), so with sixteen
sequences most of the cells a row meets belong to another sequence. Their mask is -inf and their
weight is exp(-inf) = 0. The copy and the scores were for nothing.

### What the patch changes

Before a tile is staged, each row reads its mask values for that tile, and one flag per row goes
through workgroup memory. A tile that all four rows have masked with -inf is not staged and not
scored. A row that has masked a tile the others use skips its own scores and its sum over V.

For finite K and V the result is the same. A masked cell scored -inf, which left the running
maximum where it was, and it entered the sums with the weight 0. Only -inf counts as masked, so
a mask that uses another value keeps the full path. The vec path already skips masked blocks in
its own way.

The shader gains one barrier and one subgroup reduction per tile, which is extra work where
little can be skipped. With one slot a row still skips the tiles behind its own position, and
the page was not slower (table below).

### Measurements (2026-11-17)

RTX 4090. The builds are this tree's patched sources up to `0013` and up to `0014`.

The translations are the same text. With the round-by-round comparison used for `0012`, all 44
blocks of `long-article` matched the build without `0014` with sixteen, four and one slot, for the
0.8B and the 2B model, with the `subgroups` feature hidden, with `n_probs`, and in three orders
of starting the requests: all sixteen together, in groups of 1, 4 and 16, and each as soon as
another had ended. In the extension the 262 blocks of the eight bench pages matched the
unpatched build in two passes.

Bare wllama page, `long-article`, the mean of the warm rounds (one to three per build):

| Setting                                 | Before (s) | After (s) |
| --------------------------------------- | ---------: | --------: |
| 0.8B, sixteen slots, all together       |       1.49 |      1.36 |
| 0.8B, sixteen slots, groups of 1, 4, 16 |       1.37 |      1.19 |
| 0.8B, sixteen slots, as slots free up   |       1.46 |      1.21 |
| 0.8B, four slots                        |       2.53 |      2.49 |
| 0.8B, one slot                          |       6.11 |      5.95 |
| 2B, sixteen slots                       |       3.31 |      2.98 |
| 2B, one slot                            |       9.16 |      8.98 |

A request that joins others which are already generating used to cost them one decode on this
shader for the whole cache. That is what the third row shows.

`pages-run.ts --mode live --tier g` (Chromium 158, 0.8B, extension v1.6.2), the builds alternated
over three launches each, medians of the six samples that are not the first of a launch:

| Page                             | Unpatched (ms) | `0010` to `0013` (ms) | With `0014` (ms) | From `0013` | From unpatched |
| -------------------------------- | -------------: | --------------------: | ---------------: | ----------: | -------------: |
| `long-article`                   |           2689 |                  2051 |             1876 |       −8.6% |         −30.3% |
| `first-paragraph-then-long-tail` |           2200 |                  1676 |             1589 |       −5.2% |         −27.8% |
| `many-cards`                     |           1276 |                   976 |              926 |       −5.2% |         −27.5% |
| `single-long-paragraph`          |           1376 |                  1200 |             1176 |       −2.0% |         −14.6% |
| `model-card-sidebar`             |           1050 |                   826 |              776 |       −6.1% |         −26.1% |
| `mixed-ui`                       |           1150 |                  1026 |             1001 |       −2.4% |         −13.0% |
| `headline-in-header`             |           1901 |                  1514 |             1426 |       −5.7% |         −25.0% |
| `late-mount-spa`                 |           2001 |                  1913 |             1901 |       −0.6% |          −5.0% |

`long-article` on its own, twelve such samples per build: 2451 ms unpatched, 1802 ms with `0010`
to `0013`, 1688 ms with `0014`.

The patch adds no pipeline. The warm-up after a model load took 311 ms with it and 301 ms
without (medians of three loads).

With the browser's GPU process crashed in the middle of `long-article`, the build with `0014`
finished that page and the next two on WebGPU (two runs).

### What was not measured

- Any GPU other than the RTX 4090. A GPU with a smaller subgroup takes the same shader with other
  tile and workgroup sizes, and none was run.
- A model with another kind of mask. The ones llama.cpp builds for this model hold 0 and -inf.
- K or V that are not finite. A masked cell holding infinity or NaN used to turn its row into
  NaN, and in a skipped tile it no longer does.
- The Docker build and Firefox, as for `0010`.

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
same package action with `from-source: true` so a release never ships a restored CI cache. A pull
request that only edits that workflow does not build the zip.

CI compiles wllama in one `wllama` job and reuses that artifact for Chrome and Firefox. The cache
key is `wllama-v2-<hash>` from `scripts/wllama-cache-key.ts` (applied patches, build scripts, and
`firefox-webgpu-kick.ts`; not `patches/optional/`). A restored cache is verified before packaging.
The emsdk image is cached the same way. A cache miss compiles with `emscripten/emsdk:4.0.20` and
then saves both caches from the `wllama` job, before packaging, so a later package failure does not
lose the compile. The Chrome job uploads `chrome-mv3-zip` (the store zip from `pnpm zip`) and
`chrome-mv3` (the unpacked extension), and fails if the zip is missing or smaller than 1 MiB. The
Firefox job runs `pnpm zip:firefox`, `web-ext lint` (0 errors), a second build compared with
`scripts/compare-extension-builds.ts`, and a rebuild from `pnpm source:firefox`. See
[docs/CI.md](CI.md).

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
