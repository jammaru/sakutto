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
   - Firefox GPU, kick flag off (default)
   - Firefox GPU, kick flag on (`SAKUTTO_FIREFOX_WEBGPU_KICK=1 pnpm build:wllama`, or the
     optional patch 0007 plus `FIREFOX_WEBGPU_KICK`)
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

Defaults are Alt+Shift+A / Alt+Shift+B / Alt+Shift+S. Confirm they fire and that Alt+A / Alt+B /
Alt+S still open Firefox menus rather than Sakutto. Change shortcuts from the options page
(`commands.openShortcutSettings()`). Confirm the content-script selection key matches the bound
key (and the Alt+Shift+S default before the background answers).

## Features

Page translation, bilingual view, selection, context menu, popup, options, typed translation
(up to 100,000 characters), site grant window, always-translate site. Chrome built-in translator
languages and copy must stay hidden. Private windows: default off; note what happens to the
model store if the add-on is allowed there.

## 日本語

所有者向けの手動確認です。Windows の Firefox 153 以降、GPU 付きの PC で
`about:debugging` から `.output/firefox-mv3` を一時読み込みします。GPU / CPU、ショートカット、
イベントページの寿命、計測値を記録してください。空 submit パッチは既定オフです。
