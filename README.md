# Sakutto

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/mhlbjjijfkoghmcjndgdimhdlfkhadfl?logo=googlechrome&logoColor=white&label=Chrome%20Web%20Store)](https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl)
[![Chrome Web Store users](https://img.shields.io/chrome-web-store/users/mhlbjjijfkoghmcjndgdimhdlfkhadfl?label=users)](https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl)
[![GitHub stars](https://img.shields.io/github/stars/jammaru/sakutto?style=flat&logo=github)](https://github.com/jammaru/sakutto/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/pdSRBaSr38)
[![Last commit](https://img.shields.io/github/last-commit/jammaru/sakutto)](https://github.com/jammaru/sakutto/commits/main)

Sakutto is an unofficial extension for Chrome and Firefox that translates web pages on your device. It runs [PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF) through a pinned [wllama](https://github.com/ngxson/wllama) build. Every translated line is written by PLaMo: a page waiting for the model keeps its source text rather than showing a draft from another engine. On Chrome, Chrome's Translator API is used only for the language pairs PLaMo does not support. Firefox uses PLaMo only. Not affiliated with Preferred Networks, Inc. Built with PLaMo.

The extension is free and open source (MIT). It has no ads and no paid features. The model weights are not in this repository or in the extension package.

## Install

Install Sakutto from the Chrome Web Store:

https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl

To build and load it yourself instead:

1. Install Node.js 24 and pnpm 12.
2. Clone this repository and run `pnpm install`.
3. Build the translation runtime and the extension (see [Build](#build)).
4. Chrome: open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select `.output/chrome-mv3`.
5. Firefox 153 or later (Windows first): open `about:debugging`, choose **This Firefox**, **Load Temporary Add-on**, and select `.output/firefox-mv3/manifest.json`. See [docs/FIREFOX.md](docs/FIREFOX.md).

## Shortcuts

| Action                                          | Windows / Linux              | Mac                                 |
| ----------------------------------------------- | ---------------------------- | ----------------------------------- |
| Translate the page, or restore the original     | Alt+A (Firefox: Alt+Shift+A) | Option (⌥)+A (Firefox: Alt+Shift+A) |
| Switch between replaced text and bilingual text | Alt+B (Firefox: Alt+Shift+B) | Option (⌥)+B (Firefox: Alt+Shift+B) |
| Translate the selection                         | Alt+S (Firefox: Alt+Shift+S) | Option (⌥)+S (Firefox: Alt+Shift+S) |
| Translate the text you are writing              | Alt+T (Firefox: Alt+Shift+T) | Option (⌥)+T (Firefox: Alt+Shift+T) |
| Open the PDF the tab shows in the reader        | Not set — bind one           | Not set                             |
| Translate typed text (on the typed text page)   | Ctrl+Enter                   | ⌘+Enter                             |

The same actions are in the toolbar popup and the right-click menu. Chrome keeps these keys, so you change them in Chrome's own editor: the settings page has a **Keyboard shortcuts** panel, and the popup has a **Change shortcuts** link, both of which open `chrome://extensions/shortcuts`. Firefox uses Alt+Shift+letter by default so the Windows menu bar is not taken, and **Change shortcuts** opens Firefox's own editor. The key list in the popup and the hint on the translate button follow whatever you bind there. A key Chrome has assigned is delivered as an extension command even while a text field is focused, so the page still translates. If Chrome never assigned a command, the default is handled on the page instead: the keydown does reach the page (including in a textarea), and Sakutto leaves it unprevented there so Option+letter can type a character. That in-page default does not run on `chrome://` pages or in the PDF viewer, where the content script is not injected. A key you cleared in Chrome's editor stays off; an old install that never received a key still gets the in-page default. Chrome reads Alt in an extension shortcut as Option on a Mac, so the keys are the same letters. Reloading an unpacked build from the same folder can keep a previously cleared binding in Chrome's editor. Alt+D is not a default, because Chrome on Windows and Linux uses it for the address bar.

## Typed text

While a message box, a textarea, or another editable field is focused, Alt+T (Option+T on a Mac; Alt+Shift+T on Firefox) or the あA button next to the field previews an on-device translation of what you are typing. Press the same shortcut again, or Ctrl+Enter (⌘+Enter on a Mac), to replace; Restore original puts the draft back. The preview has a language menu, and settings can skip the preview so one shortcut press translates and replaces. Japanese drafts go to English (or to your saved target if that is not Japanese); other drafts use the saved target, until you pick another language. Password fields and sites set to never translate are left alone. You can hide the あA button in settings. A Chrome-assigned page shortcut still translates the page from a field (`onCommand`). An unassigned default's keydown still reaches the field; Sakutto does not prevent it, so Option+letter can type. Compose keeps its shortcut in the field. The same PLaMo model as page translation is used; the built-in translator is not.

The popup has a **Translate typed text** button, and the options page has the same button. It opens a small extension page with a source box and a result box, so you can type or paste a paragraph and translate it without touching a page. It uses the same PLaMo model, the same licence consent, and the same load flow as page translation, and the direction follows the same target-language setting. The built-in translator is not used there: typed text is translated by PLaMo only, and a language PLaMo does not support is refused in the page rather than quietly handed to Chrome. The result has a Copy button.

## PDFs

Chrome draws a PDF in its own viewer, and no extension can read that viewer's document — so page translation cannot attach to it. Sakutto reads the PDF itself instead. With a PDF open, the popup offers **Translate this PDF** (the right-click menu has the same item): the extension fetches the same file the tab is showing, opens it in its own reader in a new tab, and translates it there. Chrome allows four commands with a default key and the four page commands use them, so opening a PDF ships without one; bind it in the browser's shortcut editor if you want a key.

The reader keeps the page as it is. Each page is drawn once by pdf.js and the translation is placed inside the box its source text filled, so a two-column paper stays two columns, a table's numbers stay under their headings, and a figure's caption stays under its figure. A block whose translation is longer than its source grows into empty space beside and below it, stops at the next block or figure, and shrinks the type only as a last resort — never below about 67% of the source size (and never below 6pt for body text, 6.5pt otherwise), where it would be unreadable. A block that still does not fit is left in the original typesetting, with a marker that opens the full translation, rather than shown cut short. Names, affiliations, and emails on the first page stay in the original spelling.

The reader translates the page you are looking at first and the rest as you reach it, so opening a 40-page report at page 30 does not wait for 29 pages of work. A PDF with no text layer (a scan, or a page that is only an image) is shown with a note that there is nothing to translate. Image-only pages are not transcribed: a guessed transcription would be translated as if it were the source, which is worse than leaving the image.

The PDF is never written to your Downloads folder. The file is fetched from the site the tab already shows (same-origin, with the cookies that tab already has), stored inside the extension, and deleted when the reader tab closes. Reloading the reader tab needs the original PDF tab, or a file you pick, because that copy is gone. A leftover from a crash is removed within a day.

## Languages

PLaMo 3 Translate supports 53 languages in either direction. The source language is detected from the page. The default target language is the browser UI language, or English when that language is not one of the 53. The popup can set a different target language for the current site.

Eleven further languages (cs, da, el, fi, kn, no, pt, ro, sv, tr, uk) are translated only by Chrome's built-in translator, and only in Chrome. Firefox hides those targets. Languages that PLaMo supports stay untranslated until the model is ready.

The interface itself is translated into 14 languages: English, Japanese, Korean, Chinese (Simplified and Traditional), Spanish, Portuguese (Brazil), French, German, Italian, Russian, Vietnamese, Thai, and Indonesian. Chrome picks the catalog that matches the browser UI language and falls back to English. To add one, see [docs/TRANSLATING.md](docs/TRANSLATING.md).

## Privacy

Translation runs on your device by default. The extension does not send page text, selections, your glossary, or translations to the developer. There is no account, ads, or telemetry. The built-in engine's own network request is the model download from Hugging Face, and, for a PDF, the file from the site the tab already shows. If you turn on the **experimental local server** in Settings (mlx_lm.server, LM Studio, or another OpenAI-compatible process on this computer), the text to translate is sent only to the address you set — not to the developer. Accuracy is not guaranteed. Read the policy at [PRIVACY.md](PRIVACY.md) or https://jammaru.com/sakutto/privacy/.

## Local server (experimental)

The default engine is the packaged wllama runtime (WebGPU or CPU). Settings can point PLaMo requests at an OpenAI-compatible server on this machine instead. That path is **experimental**: accuracy is not guaranteed, and translations can differ from the built-in engine, including mistranslations. A Mac check of MLX 4bit, 8bit, and bf16 showed errors the built-in engine did not; the difference comes from quantization numerics, not from a different request. Use raw `/v1/completions` with Sakutto's PFML3 prompt; chat completions are not used. Recipes:

- `mlx_lm.server` — default `http://127.0.0.1:8080/v1`, PLaMo MLX-4bit weights from [the PLaMo 3 Translate collection](https://huggingface.co/collections/pfnet/plamo-3-translate)
- LM Studio — default `http://127.0.0.1:1234/v1`

In LM Studio, set the server-side sampler to temperature 0 / greedy. Prompt parity is measured against `mlx_lm.server` and PLaMo's `serve.py`; LM Studio's BOS handling is unverified.

Design, model pins, and what was not measured on Linux: [docs/design/mlx-backend.md](docs/design/mlx-backend.md). Mac timings: [bench/README.md](bench/README.md).

## Build

```bash
pnpm install
pnpm build:wllama   # once, with Docker; see docs/BUILDING.md
pnpm verify:wllama
pnpm build          # production build in .output/chrome-mv3
pnpm build:firefox  # Firefox 153+ MV3 in .output/firefox-mv3
pnpm zip            # Chrome Web Store zip in .output
pnpm zip:firefox    # Firefox zip in .output; then pnpm source:firefox for the AMO source zip
```

`pnpm build:wllama` compiles the pinned wllama commit `d275dac` inside the `emscripten/emsdk:4.0.20` container. The wasm, workers, and model weights are not committed. `pnpm build` and `pnpm zip` refuse to run until that build has been verified. `pnpm zip` also checks that the package contains the runtime and the license texts, and that it does not contain model weights, source maps, or install-time host permissions.

`pnpm build` copies the pinned `pdfjs-dist` build into the package first (`pnpm pdfjs` runs that step alone). The reader loads it from a packaged file, because pdf.js resolves its worker, its CMaps and its standard font substitutes relative to itself; a bundled copy would lose that base and go looking on a CDN. The PDF fixtures and the reader's own checks are described next.

```bash
pnpm dev            # development build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e       # local fixtures; does not download the model
```

`pnpm test:e2e` builds a test package that translates inside the page. That package is not the release build. The release build does not include the test translator.

`pnpm bench` loads the built extension in headless Chromium (Playwright's Chrome for Testing build, because branded Chrome refuses `--load-extension`) and translates four fixed local pages with the real 0.8B model: a long article, a news article, a docs page, and a client-rendered page. It also runs a short engine probe for time to first token and output speed. Pass `--pages-only`, `--engine-only`, or `--sweep` (thread, context, and batch sizes). The model is cached under `bench/.cache/` after a SHA-256 check. Build with `SAKUTTO_E2E_REAL=1 pnpm build` first so the harness can script the local pages. Results are written to `bench/results/`.

`pnpm bench:mock` and `pnpm bench:live` measure whole pages the way a reader experiences them, on eight fixtures in [bench/pages](bench/pages) that each isolate a different cost (a long article, a short lead with a long tail, many short cards, one very long paragraph, a sidebar, mixed UI, a headline inside the article header, and late-mounted content). Every run appends to `bench/history/pages.jsonl`, so a later commit can be diffed against an earlier one on the same pages. `pnpm bench:serve` opens those fixtures in your own browser. See [bench/README.md](bench/README.md) for the metrics, the mock-versus-live distinction, and how to add a fixture.

`pnpm icons` regenerates the PNG icons from `scripts/generate-icons.mjs`.

`pnpm i18n:check` compares every catalog in `public/_locales` against English for missing keys, placeholder tokens, and empty messages. `pnpm i18n:draft <catalog> <language>` drafts a catalog from English with the same PLaMo model the extension ships. Both are described in [docs/TRANSLATING.md](docs/TRANSLATING.md).

## PDF bench

`bench/pdf/paper.html` is an original two-column academic paper written for this repository, and `scripts/bench/build-pdf-fixtures.ts` prints it to `bench/pdf/paper.pdf` with a real text layer (font subsets, per-glyph positions, a table and a figure), plus `bench/pdf/scan.pdf`, the same layout as one bitmap per page with no text layer. Both are committed: they are our own text, so they are small and stay under the MIT license.

Layout quality is checked in two speeds:

- **Fast, in CI.** `pnpm test` runs synthetic pages (two-column prose, display equations, figure labels versus axis ticks, tables, listings, running footers, image-only pages) through the same cut, fit and overlap rules the reader uses, with a deterministic stub translator that expands like Japanese. No model is loaded. `pnpm bench:pdf:layout` runs that path on the committed PDF fixtures; it should finish in a few seconds.
- **Slow, on a machine with the model.** `pnpm bench:pdf` loads the built extension, opens a fixture through the real `pdf:open` path, and translates with PLaMo. Use `--pages N` to bound a long file, `--shot-page N` to screenshot one page, and `--keep-cache` to reuse translations already in the profile so a re-run is only the pages that changed.

```bash
pnpm test                 # includes the layout-only PDF checks
pnpm bench:pdf:layout     # committed fixtures, stub translator, no model
pnpm bench:build:live     # the build the live bench loads
pnpm bench:pdf            # 8 threads, real model
pnpm bench:pdf --threads 4
pnpm bench:pdf --page scan   # the bitmap fixture, which must report no text
pnpm bench:pdf --keep-cache  # reuse translations already in the profile
```

**One model, downloaded once.** The profile at `bench/.cache/pdf-profile` keeps what the extension stored in it, so the 546 MB model is fetched on the first run and loaded from disk afterwards; a later run prints `loaded from the profile` and requests nothing. The extension is always staged at `bench/.cache/ext-live` because an unpacked extension's ID comes from its path, and its private file system is keyed by that ID — loading a build from a second path would put a second copy of the model in the same profile. The run reports how many copies it found (`1 copy of the model on disk`) and warns when it is more. Delete the profile directory to start from nothing.

## Permissions

| Permission         | Why it is requested                                                                  |
| ------------------ | ------------------------------------------------------------------------------------ |
| `storage`          | Saves the target language, reading style, and other settings.                        |
| `unlimitedStorage` | Keeps the downloaded model and the translation cache on the device.                  |
| `offscreen`        | Runs the translation runtime in a document whose workers outlive the service worker. |
| `activeTab`        | Reads the current page after you open the popup or use a command.                    |
| `scripting`        | Injects the content script into the active tab after you ask for a translation.      |
| `contextMenus`     | Adds Translate page, Translate selection and Translate PDF to the right-click menu.  |

Optional host permissions (`https://*/*` and `http://*/*`) are requested only when you turn on automatic translation for a site. Nothing is requested for every site at install time. The PDF reader adds no permission: it reads the file from the origin the `activeTab` grant already covers.

## Support

There is no monetisation point in Sakutto. It is completely free, with no ads and no paid features.

I started it because I wanted a translation extension like this myself, and I published it because it turned out to be needed by more people than I expected. I have no plans to charge for it or to add ads.

Continuing development still takes time and money, so I opened GitHub Sponsors. If you like Sakutto, I would be glad of your support.

- **$5 a month (Supporter)**: a plan for cheering on Sakutto's ongoing development.
- **$10 a month (Backer)**: for anyone who wants to back it further. The amount changes nothing about the software.
- **One-time**: any amount, once, if a subscription is more than you need.

Neither tier adds limited features or priority support. The money goes towards new features, translation quality and speed, and ongoing maintenance. Whether you sponsor or not, Sakutto stays completely free and open source. https://github.com/sponsors/jammaru

## Contributing

Open an [Issue](https://github.com/jammaru/sakutto/issues) first, then a pull request for that Issue if you can. That path is fully welcome. A PR is very much wanted; an Issue by itself is also enough. Please use the issue forms, and do not paste private page content. Questions are often faster in [Discord](https://discord.gg/pdSRBaSr38).

- [CONTRIBUTING.md](CONTRIBUTING.md) (日本語: [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md))
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)

## Licenses

- Project code: MIT. See [LICENSE](LICENSE). Copyright 2026 jammaru.
- PLaMo 3 Translate: PLaMo Community License. The texts are in `licenses/PLaMo-Community-License-ja.txt` and `licenses/PLaMo-Community-License-en.txt`, and the same copies are packed into the extension. Personal and academic use needs no registration. Under Article 3 the model's license allows commercial use only with prior registration on PFN's form (https://forms.gle/mTL8tBLrMYXKNZD56) and income or sales for you or your affiliates of no more than 1 billion yen in the most recent fiscal year; otherwise commercial use needs a separate commercial license from PFN. This repository's MIT license covers Sakutto's own code, not the model weights.
- pdf.js (`pdfjs-dist`): Apache-2.0. The packaged copy is pinned in `package.json`, its files and their SHA-256 hashes are recorded in `public/vendor/pdfjs/pdfjs-build.json`, and its licence is packed as `vendor/pdfjs/LICENSE-pdfjs.txt` together with the CMaps' and the standard fonts' own licences.
- llama.cpp, wllama, the Emscripten runtime, the Dawn WebGPU library, and Svelte: see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- `scripts/bench/fixtures/kyoto.html` is a CC BY-SA 4.0 Wikipedia derivative. It is not covered by the MIT license and is not part of the extension package.

Japanese documentation: [README.ja.md](README.ja.md).
