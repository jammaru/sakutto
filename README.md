# Sakutto

Sakutto is an unofficial Chrome extension that translates web pages on your device. It runs [PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF) through a pinned [wllama](https://github.com/ngxson/wllama) build. Every translated line is written by PLaMo: a page waiting for the model keeps its source text rather than showing a draft from another engine. Chrome's Translator API is used only for the language pairs PLaMo does not support. Not affiliated with Preferred Networks, Inc. Built with PLaMo.

The extension is free and open source (MIT). It has no ads and no paid features. The model weights are not in this repository or in the extension package.

## Install

The Chrome Web Store listing is not published yet. Until it is, install from source:

1. Install Node.js 24 and pnpm 12.
2. Clone this repository and run `pnpm install`.
3. Build the translation runtime and the extension (see [Build](#build)).
4. Open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Choose **Load unpacked**.
7. Select the `.output/chrome-mv3` directory in this repository.

## Shortcuts

| Action                                          | Default |
| ----------------------------------------------- | ------- |
| Translate the page, or restore the original     | Alt+A   |
| Switch between replaced text and bilingual text | Alt+B   |
| Translate the selection                         | Alt+S   |

The same actions are in the toolbar popup and the right-click menu. Change the keys at `chrome://extensions/shortcuts`. Alt+D is not used, because Chrome uses it for the address bar.

## Languages

PLaMo 3 Translate supports 53 languages in either direction. The source language is detected from the page. The default target language is the browser UI language, or English when that language is not one of the 53. The popup can set a different target language for the current site.

Eleven further languages (cs, da, el, fi, kn, no, pt, ro, sv, tr, uk) are translated only by Chrome's built-in translator. Languages that PLaMo supports and Chrome does not stay untranslated until the model is ready.

## Privacy

The extension does not send page text to a server, and it has no telemetry. Its own request is the model download, which starts at `huggingface.co` and follows Hugging Face's redirect to a CDN. That request carries the file request and connection metadata, not the page text. Chrome may separately download a built-in translation language pack, which is used only for the pairs PLaMo does not translate. PLaMo translation works offline only after the checked model file is stored. Details are in [PRIVACY.md](PRIVACY.md).

## Build

```bash
pnpm install
pnpm build:wllama   # once, with Docker; see docs/BUILDING.md
pnpm verify:wllama
pnpm build          # production build in .output/chrome-mv3
pnpm zip            # Chrome Web Store zip in .output
```

`pnpm build:wllama` compiles the pinned wllama commit `d275dac` inside the `emscripten/emsdk:4.0.20` container. The wasm, workers, and model weights are not committed. `pnpm build` and `pnpm zip` refuse to run until that build has been verified. `pnpm zip` also checks that the package contains the runtime and the license texts, and that it does not contain model weights, source maps, or install-time host permissions.

```bash
pnpm dev            # development build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e       # local fixtures; does not download the model
```

`pnpm test:e2e` builds a test package that translates inside the page. That package is not the release build. The release build does not include the test translator.

`pnpm bench` loads the built extension in headless Chromium (Playwright's Chrome for Testing build, because branded Chrome refuses `--load-extension`) and translates four fixed local pages with the real 0.8B model: a long article, a news article, a docs page, and a client-rendered page. It also runs a short engine probe for time to first token and output speed. Pass `--pages-only`, `--engine-only`, or `--sweep` (thread, context, and batch sizes). The model is cached under `bench/.cache/` after a SHA-256 check. Build with `SAKUTTO_E2E_REAL=1 pnpm build` first so the harness can script the local pages. Results are written to `bench/results/`.

`pnpm icons` regenerates the PNG icons from `scripts/generate-icons.mjs`.

## Permissions

| Permission         | Why it is requested                                                                  |
| ------------------ | ------------------------------------------------------------------------------------ |
| `storage`          | Saves the target language, reading style, and other settings.                        |
| `unlimitedStorage` | Keeps the downloaded model and the translation cache on the device.                  |
| `offscreen`        | Runs the translation runtime in a document whose workers outlive the service worker. |
| `activeTab`        | Reads the current page after you open the popup or use a command.                    |
| `scripting`        | Injects the content script into the active tab after you ask for a translation.      |
| `contextMenus`     | Adds Translate page and Translate selection to the right-click menu.                 |

Optional host permissions (`https://*/*` and `http://*/*`) are requested only when you turn on automatic translation for a site. Nothing is requested for every site at install time.

## Licenses

- Project code: MIT. See [LICENSE](LICENSE). Copyright 2026 jammaru.
- PLaMo 3 Translate: PLaMo Community License. The texts are in `licenses/PLaMo-Community-License-ja.txt` and `licenses/PLaMo-Community-License-en.txt`, and the same copies are packed into the extension.
- llama.cpp, wllama, the Emscripten runtime, the Dawn WebGPU library, and Svelte: see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- `scripts/bench/fixtures/kyoto.html` is a CC BY-SA 4.0 Wikipedia derivative. It is not covered by the MIT license and is not part of the extension package.

Japanese documentation: [README.ja.md](README.ja.md).
