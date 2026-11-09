# Firefox manual test checklist

Owner-only. First target: **Windows Firefox 153 or later** (ESR 153 included), on a PC with a GPU.
This is not a substitute for `pnpm test` or `web-ext lint`. Do not paste Chrome Web Store numbers
into the listing until this list has measurements from this machine.

Load the unpacked build from `about:debugging` (This Firefox → Load Temporary Add-on →
`.output/firefox-mv3/manifest.json`). `web-ext lint` on that directory must report 0 errors.

## Environment to record

From `about:support` and the options page diagnostics:

- Firefox version (release and, if possible, ESR 153)
- OS, GPU name, driver
- WebGPU enabled
- `crossOriginIsolated` (expected false)
- `navigator.gpu` present
- `shader-f16` on the adapter (`adapter.features.has('shader-f16')`)
- JSPI (`WebAssembly.Suspending`) present
- `navigator.storage.persist()` result after the first model download

## GPU vs CPU

1. Download the 0.8B model. Interrupt once and resume. Restart Firefox and confirm the file is
   still in OPFS.
2. Translate `bench/pages` fixtures `long-article` and `many-cards` (or the same live pages).
   Record first visible translation, on-screen range done, and full page, in milliseconds, for:
   - Firefox GPU, kick on (default; empty `queue.submit` during `mapAsync`, bug 1870699)
   - Firefox GPU, kick off (`SAKUTTO_FIREFOX_WEBGPU_KICK=0` at wasm build, or flip `enabled` in
     the packaged `wllama-worker.js`)
   - Firefox CPU (force the CPU tier; expect 1 thread)
   - Chrome on the same PC, same pages
3. Confirm llama.cpp logs `using device WebGPU` and `offloaded N/N layers` on the GPU path.
   Confirm no WGSL / naga compile error.
4. On a machine where WebGPU is blocked, confirm the add-on falls back to CPU without throwing.

Write results as "about N times faster/slower", seconds, and the conditions. Do not reuse Chrome
listing numbers.

## Event page

1. Leave the browser idle for more than 30 seconds, then translate. The model may reload; the
   page must still translate.
2. Translate a long page for more than five minutes. It must not stop mid-page. If the event
   page did die, it must come back on the next request.

## Shortcuts

Defaults are Alt+Shift+A / Alt+Shift+B / Alt+Shift+S / Alt+Shift+T. Confirm they fire and that
Alt+A / Alt+B / Alt+S / Alt+T still open Firefox menus rather than Sakutto. Ctrl+Shift+T remains
Firefox's undo-close-tab. Change shortcuts from the options page
(`commands.openShortcutSettings()`). Confirm the content-script selection and compose keys match
the bound keys (and the Alt+Shift+S / Alt+Shift+T defaults before the background answers).

## Features

Page translation, bilingual view, selection, compose (live preview bar, あA button, input-field
context menu), context menu, popup, options, typed translation (up to 100,000 characters), site
grant window, always-translate site. Chrome built-in translator languages and copy must stay
hidden. Private windows: default off; note what happens to the model store if the add-on is
allowed there.

## Learnings — 2026-11-09 (Windows Firefox 159, RTX 4070 Ti SUPER)

The Chromium page-bench harness in `bench/` cannot drive Firefox, so this measurement is a
manual run on real hardware. Tables in the same shape as `bench/results/pages/` live in
[`bench/results/pages/firefox-webgpu-kick-20261109.md`](../bench/results/pages/firefox-webgpu-kick-20261109.md).

### Baseline, and what made it faster

Firefox WebGPU only polls completed GPU work about every 100 ms ([bug 1870699](https://bugzilla.mozilla.org/show_bug.cgi?id=1870699)).
While `GPUBuffer.mapAsync` waits, Sakutto submits an empty `queue.submit([])` so the browser
notices finished work sooner. The kick does not change llama.cpp math, prompts, or sampling:
output must stay identical, and any error restores the original GPU methods so inference
continues on the unaccelerated path.

Until this measurement the switch stayed off (`FIREFOX_WEBGPU_KICK = false`). It is now
default-on for Firefox. `SAKUTTO_FIREFOX_WEBGPU_KICK=0` still turns it off at wasm build time.

### Numbers

Conditions: Windows Firefox 159.0, RTX 4070 Ti SUPER, PLaMo 3 Translate 0.8B Q4_K_M, a 5-block
English page (4 paragraphs + heading). Output identical in the three Firefox paths.

| Path                                        | Full page | First sentence | Notes                                                           |
| ------------------------------------------- | --------: | -------------: | --------------------------------------------------------------- |
| Firefox WebGPU, kick off (previous default) | 8.4–9.0 s |         ~1.1 s | ~11.6 tok/s                                                     |
| Firefox CPU, 1 thread                       |    15.8 s |          2.7 s | No COOP/COEP in extension pages, so CPU cannot use wasm threads |
| Firefox WebGPU, kick on (now default)       | 1.6–1.9 s |    0.55–0.83 s | ~5× full page vs kick off                                       |
| Chrome WebGPU (same PC, same page)          |   ~0.86 s |              — | Reference only; do not paste into the AMO listing               |

### How to reproduce

1. `pnpm build:firefox` and load `.output/firefox-mv3/manifest.json` from `about:debugging`.
2. Agree to the license, wait for the 0.8B model, confirm diagnostics show WebGPU.
3. Open a 5-block English page (4 paragraphs + heading). Translate the page. Record first
   sentence and full-page wall time from the overlay (or a stopwatch on a cold load).
4. Repeat with CPU forced in settings (expect 1 thread).
5. A/B the kick by flipping `var enabled` in packaged `vendor/wllama/wllama-worker.js`, or
   rebuild wasm with `SAKUTTO_FIREFOX_WEBGPU_KICK=0`. Confirm the translated text matches.

The Playwright `pnpm bench:live` path is Chromium-only (`bench/README.md`). Use it for Chrome
comparisons; do not mix those JSONL rows with this Firefox table.

### Known limits

- Firefox extension pages are not cross-origin isolated (bugs 1673477, 1750654). CPU is
  single-threaded (`c1`).
- Bug 1870699 is why the empty submit helps; if Mozilla ships a real completion poll, the
  kick becomes a no-op and can be turned off.
- The kick lives in the generated `vendor/wllama/dist/wllama-worker.js`. A vendor tree built
  before the bootstrap existed still passes the sha256 checks against its own manifest, but
  runs without the kick. 2026-11-10, Windows Firefox 159 / RTX 4070 Ti SUPER, the same
  Wikipedia article (196 blocks), cache cleared, 45 s each: worker without the bootstrap
  8–37 tok/s, 14/196 blocks, GPU mostly idle; worker with it 80–108 tok/s, 69/196 blocks
  (about 5 times faster). The CI-built worker on the same page got 60–85 tok/s and 116/196
  blocks. `pnpm verify:wllama` now fails on such a worker. If a Firefox page
  shows ~30 tok/s with `n_parallel 4` and the GPU near idle, rebuild with `pnpm build:wllama`.

## 日本語

所有者向けの手動確認です。Windows の Firefox 153 以降、GPU 付きの PC で
`about:debugging` から `.output/firefox-mv3` を一時読み込みします。GPU / CPU、ショートカット、
イベントページの寿命、計測値を記録してください。空 submit による WebGPU 待ちの短縮は既定オンです
（2026-11-09、Windows Firefox 159 / RTX 4070 Ti SUPER で約 5 倍）。
