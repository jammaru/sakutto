# AMO review notes

Reviewer-facing facts for the Firefox package. Paste the English block into Notes for Reviewers.
The Japanese block is for the owner. Implementation pins that belong in a review note live here;
the public policy is `PRIVACY.md`.

Repository: https://github.com/jammaru/sakutto

Privacy policy: https://jammaru.com/sakutto/privacy/

Gecko id (confirm before first listed upload; it cannot change afterwards): `sakutto@jammaru`

`strict_min_version`: 153.0 (JSPI, WebGPU, memory64), including ESR 153. Desktop Firefox on Windows, macOS, and Linux. Tested on Windows. The manifest has no OS filter. `gecko_android` is not set, so this is not listed for Firefox for Android.

## Notes to paste

```text
Sakutto (https://github.com/jammaru/sakutto) translates web pages on the device. It is unofficial and is not affiliated with Preferred Networks. Built with PLaMo. The packaged name in _locales/en is Sakutto - Local AI translation and in _locales/ja it is Sakutto - ローカルAI翻訳; the short name is Sakutto in both. There is no account, no analytics, and no telemetry.

Single purpose: translating web pages.

Privacy policy: https://jammaru.com/sakutto/privacy/

data_collection_permissions: none. Translation runs on the device. The only network request this add-on makes is a PLaMo 3 Translate GGUF weight from huggingface.co. The URL is pinned to a commit. Bytes are hashed against a pinned SHA-256 before they are kept. Page text is not included. Hugging Face can see the IP address and the file request.

Remote code: none. Every script, worker, and wasm the add-on executes is in the xpi under vendor/wllama/. Dynamic import() loads only vendor/wllama/wllama.js from the extension origin (src/engine/wllama/assets.ts, isExtensionAssetUrl). There is no external COOP/COEP page.

Firefox has no offscreen documents. The engine runs in an iframe of offscreen.html inside the MV3 event page. storage.session is written about every 15 seconds while that frame exists so the event page is not killed after 30 seconds (bug 1851373). Message ports are not used to keep the page alive.

Firefox extension pages are not cross-origin isolated (bugs 1673477, 1750654). CPU inference is therefore one thread on every desktop OS. WebGPU is preferred when the adapter is present. When WebGPU is unavailable the model runs on the CPU.

Chrome's Translator API and Language Detector are not used on Firefox. Chrome-only target languages are hidden.

The packaged runtime is a pinned build of wllama (commit d275dac17bc7f190161deb24fd834ce03342e2bc, llama.cpp 5aeac37a35b44fde4bdffaec9159f2fcb253b622) with the patches in scripts/wllama/patches/ (static worker, packaged asset paths, wasm SIMD CPU kernels, WebGPU bind-group reuse, disable prompt cache, retry Dawn download). This is Sakutto's own compiled code, not an unmodified third-party release. Source, patches, Dockerfile, and rebuild steps are in the source zip (SOURCE_CODE_REVIEW.md, docs/BUILDING.md).

scripts/wllama/patches/optional/0007-firefox-webgpu-kick.patch is a workaround for Firefox bug 1870699 (100ms GPU completion polling). It is not applied as a llama.cpp patch. The packaged worker still contains the helper; FIREFOX_WEBGPU_KICK is now true after a Windows Firefox 159 / RTX 4070 Ti SUPER measurement (full page 8.4–9.0s → 1.6–1.9s, identical output; docs/FIREFOX.md). The helper is UA-gated to Firefox, empty queue.submit only, and restores the original GPU methods on any error. SAKUTTO_FIREFOX_WEBGPU_KICK=0 disables it.

web-ext lint on the packaged add-on is required to report 0 errors. Two warnings are expected and are not remote code:

1. innerHTML: Svelte compiles some extension-page text updates to innerHTML. The in-page overlay (src/dom/overlay.ts) is drawn with DOM constructors, not innerHTML, and never assigns page content as HTML.
2. dynamic import(): src/engine/wllama/module.ts import()s only vendor/wllama/wllama.js after isExtensionAssetUrl confirms the URL is this add-on's origin.

How to try it: load the unpacked directory from about:debugging, agree to the PLaMo Community License on first run, wait for the 0.8B model to download and hash, then translate a page. GPU evidence is llama.cpp log lines "using device WebGPU" and "offloaded N/N layers".

Model pins from src/engine/model/catalog.ts:

0.8B default
id plamo-3-translate-0.8b-q4_k_m
repo pfnet/plamo-3-translate-0.8b-GGUF
file plamo-3-translate-0.8b-Q4_K_M.gguf
commit dbeb0856cb0b004b484f190bb71dd65876297013
size 573123200
sha256 923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd

2B optional
id plamo-3-translate-2b-q4_k_m
repo pfnet/plamo-3-translate-2b-GGUF
file plamo-3-translate-2b-Q4_K_M.gguf
commit 232fbd7916519edecddfdae0beae7e76fe70453f
size 1807199392
sha256 f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0
```

## 日本語（所有者向け）

Firefox 版の審査メモです。gecko id `sakutto@jammaru` は初回 listed の前に確認してください。対象はデスクトップの Firefox（Windows、macOS、Linux）です。確認したのは Windows。macOS と Linux をマニフェストで除外してはいません。Android 向けの `gecko_android` は付けていません。パッチを当てた wllama は「Sakutto 自身のコンパイル済みコード」として出し、ソース zip に手順を入れています。空 submit の WebGPU 回避策は既定オンです（計測は docs/FIREFOX.md）。Chrome 内蔵 Translator は Firefox では使いません。web-ext lint の innerHTML / dynamic import 警告は審査メモに理由を書いてあります。
