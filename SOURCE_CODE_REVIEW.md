# Source code review (Firefox / AMO)

This archive is the source for the Firefox package of Sakutto. Reviewers can rebuild the
extension from it. The AMO listing notes (`docs/AMO_REVIEW_NOTES.md`) repeat the same pins.

## Environment

Mozilla's standard review environment is Ubuntu 24.04 on ARM64, Node 24, npm 11. This
project uses **pnpm 12** (`packageManager` in `package.json`) and **Node 24**. Install pnpm
with `corepack enable` or `npm install -g pnpm@12.15.0`.

The wasm runtime is compiled in Docker with `emscripten/emsdk:4.0.20`. On ARM64 the build
script uses `emscripten/emsdk:4.0.20-arm64`. The two images do not produce identical wasm
bytes. Compare the extension's JS/HTML/CSS and `manifest.json` across rebuilds; treat wasm
as produced by the documented image for that CPU.

Docker Engine with Compose v2 is required for `pnpm build:wllama`. `emcc` is not required on
the host. Several GB of disk and tens of minutes are needed for a cold wasm build.

## Commands

From the extracted source:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build:wllama
pnpm verify:wllama
pnpm zip:firefox
```

The unpacked extension is `.output/firefox-mv3`. The store zip is in `.output/` (a
`*-firefox-*.zip`, not the `*-sources.zip`).

```sh
pnpm exec web-ext lint --source-dir .output/firefox-mv3
```

That lint must report 0 errors. Warnings about Svelte `innerHTML` and the dynamic `import()`
of the bundled `vendor/wllama/wllama.js` are expected: that import is restricted to the
extension origin (`isExtensionAssetUrl` in `src/engine/wllama/assets.ts`).

To rebuild only the extension after wasm is present:

```sh
pnpm build:firefox
```

## What this package contains

- This repository's source (TypeScript, Svelte, scripts, locale catalogs, tests)
- `scripts/wllama/patches/` applied at wasm build time (`git apply` of top-level `*.patch` only)
- `scripts/wllama/patches/optional/0007-firefox-webgpu-kick.patch` is **not** applied. The worker
  bootstrap still contains the empty-`queue.submit` helper and now defaults to `enabled = true`
  (Firefox UA only; originals restored on error). To A/B it off: `SAKUTTO_FIREFOX_WEBGPU_KICK=0
pnpm build:wllama`. A Firefox session also injects `firefoxWebGpuKick` on the worker URL so a
  cached wasm that still bakes `enabled = false` gets the same path. Measurement:
  `docs/FIREFOX.md`, `bench/results/pages/firefox-webgpu-kick-20261109.md`.
- `scripts/wllama/Dockerfile` pinning the emsdk image
- When the vendor checkout was present at pack time, `vendor/wllama/.checkout` at the pinned
  wllama and llama.cpp commits (without `node_modules` or build directories)

Pinned commits are in `scripts/wllama/pins.ts` and `docs/BUILDING.md`.

## Third-party runtime

The shipped wasm is Sakutto's own compile of pinned wllama + llama.cpp + Dawn (emdawnwebgpu),
with the MV3 and ggml patches listed in `docs/BUILDING.md`. It is not an unmodified upstream
release tarball. The patches and the reason for each are in that file and in
`docs/AMO_REVIEW_NOTES.md`.

Model weights are not in this source package or in the xpi. They are GGUF data downloaded from
Hugging Face on first use, hashed against pins in `src/engine/model/catalog.ts`.

## Firefox-only behaviour reviewers should know

- `strict_min_version` is `153.0` (JSPI + WebGPU + memory64).
- There is no `offscreen` permission. The engine page is an iframe of `offscreen.html` inside
  the MV3 event page, kept alive with `storage.session` writes while it is open.
- Extension pages are not `crossOriginIsolated`, so CPU inference is one thread (`c1`).
- Chrome's Translator API is not used. PLaMo-only language pairs are the whole product on
  Firefox.
- No remote code is loaded. Do not point the engine at an external COOP/COEP page.

## Reproducing the xpi bytes

CI builds the Firefox package twice and unpacks a source zip to build it a third time, then
compares the unpacked trees (`scripts/compare-extension-builds.ts`). Zip timestamps may
differ; file contents must not.
