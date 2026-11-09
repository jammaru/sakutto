# Sakutto

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/mhlbjjijfkoghmcjndgdimhdlfkhadfl?logo=googlechrome&logoColor=white&label=Chrome%20Web%20Store)](https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl)
[![Chrome Web Store users](https://img.shields.io/chrome-web-store/users/mhlbjjijfkoghmcjndgdimhdlfkhadfl?label=users)](https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl)
[![GitHub stars](https://img.shields.io/github/stars/jammaru/sakutto?style=flat&logo=github)](https://github.com/jammaru/sakutto/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/pdSRBaSr38)
[![Last commit](https://img.shields.io/github/last-commit/jammaru/sakutto)](https://github.com/jammaru/sakutto/commits/main)

Sakutto is an unofficial Chrome extension that translates web pages on your device. It runs [PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF) through a pinned [wllama](https://github.com/ngxson/wllama) build. Every translated line is written by PLaMo: a page waiting for the model keeps its source text rather than showing a draft from another engine. Chrome's Translator API is used only for the language pairs PLaMo does not support. Not affiliated with Preferred Networks, Inc. Built with PLaMo.

The extension is free and open source (MIT). It has no ads and no paid features. The model weights are not in this repository or in the extension package.

## Install

Install Sakutto from the Chrome Web Store:

https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl

To build and load it yourself instead:

1. Install Node.js 24 and pnpm 12.
2. Clone this repository and run `pnpm install`.
3. Build the translation runtime and the extension (see [Build](#build)).
4. Open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Choose **Load unpacked**.
7. Select the `.output/chrome-mv3` directory in this repository.

## Shortcuts

| Action                                          | Windows / Linux | Mac          |
| ----------------------------------------------- | --------------- | ------------ |
| Translate the page, or restore the original     | Alt+A           | Option (⌥)+A |
| Switch between replaced text and bilingual text | Alt+B           | Option (⌥)+B |
| Translate the selection                         | Alt+S           | Option (⌥)+S |
| Translate the text you are writing              | Alt+T           | Option (⌥)+T |
| Translate typed text (on the typed text page)   | Ctrl+Enter      | ⌘+Enter      |

The same actions are in the toolbar popup and the right-click menu. Chrome keeps these keys, so you change them in Chrome's own editor: the settings page has a **Keyboard shortcuts** panel, and the popup has a **Change shortcuts** link, both of which open `chrome://extensions/shortcuts`. The key list in the popup and the hint on the translate button follow whatever you bind there. Clearing a key in that editor stops Sakutto from handling it. If Chrome could not assign a suggested key at install (for example because another extension already uses it), the default still works on pages until you turn that shortcut off in Sakutto. Chrome reads Alt in an extension shortcut as Option on a Mac, so the keys are the same letters. Alt+D is not a default, because Chrome on Windows and Linux uses it for the address bar.

## Typed text

While a message box, a textarea, or another editable field is focused, Alt+T (Option+T on a Mac) or the あA button next to the field previews an on-device translation of what you are typing. Press the same shortcut again, or Ctrl+Enter (⌘+Enter on a Mac), to replace; Restore original puts the draft back. The preview has a language menu, and settings can skip the preview so one shortcut press translates and replaces. Japanese drafts go to English (or to your saved target if that is not Japanese); other drafts use the saved target, until you pick another language. Password fields and sites set to never translate are left alone. You can hide the あA button in settings. If Chrome never assigned Alt+T at install, that default still works on pages; clearing it in Chrome's shortcut editor turns it off. The same PLaMo model as page translation is used; the built-in translator is not.

The popup has a **Translate typed text** button, and the options page has the same button. It opens a small extension page with a source box and a result box, so you can type or paste a paragraph and translate it without touching a page. It uses the same PLaMo model, the same licence consent, and the same load flow as page translation, and the direction follows the same target-language setting. The built-in translator is not used there: typed text is translated by PLaMo only, and a language PLaMo does not support is refused in the page rather than quietly handed to Chrome. The result has a Copy button.

## Languages

PLaMo 3 Translate supports 53 languages in either direction. The source language is detected from the page. The default target language is the browser UI language, or English when that language is not one of the 53. The popup can set a different target language for the current site.

Eleven further languages (cs, da, el, fi, kn, no, pt, ro, sv, tr, uk) are translated only by Chrome's built-in translator. Languages that PLaMo supports and Chrome does not stay untranslated until the model is ready.

The interface itself is translated into 14 languages: English, Japanese, Korean, Chinese (Simplified and Traditional), Spanish, Portuguese (Brazil), French, German, Italian, Russian, Vietnamese, Thai, and Indonesian. Chrome picks the catalog that matches the browser UI language and falls back to English. To add one, see [docs/TRANSLATING.md](docs/TRANSLATING.md).

## Privacy

Translation runs on your device. The extension does not send page text, selections, your glossary, or translations to the developer or to any translation server, and it has no account, ads, or telemetry. Its own network request is the model download from Hugging Face. Read the policy at [PRIVACY.md](PRIVACY.md) or https://jammaru.com/sakutto/privacy/.

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

`pnpm bench:mock` and `pnpm bench:live` measure whole pages the way a reader experiences them, on eight fixtures in [bench/pages](bench/pages) that each isolate a different cost (a long article, a short lead with a long tail, many short cards, one very long paragraph, a sidebar, mixed UI, a headline inside the article header, and late-mounted content). Every run appends to `bench/history/pages.jsonl`, so a later commit can be diffed against an earlier one on the same pages. `pnpm bench:serve` opens those fixtures in your own browser. See [bench/README.md](bench/README.md) for the metrics, the mock-versus-live distinction, and how to add a fixture.

`pnpm icons` regenerates the PNG icons from `scripts/generate-icons.mjs`.

`pnpm i18n:check` compares every catalog in `public/_locales` against English for missing keys, placeholder tokens, and empty messages. `pnpm i18n:draft <catalog> <language>` drafts a catalog from English with the same PLaMo model the extension ships. Both are described in [docs/TRANSLATING.md](docs/TRANSLATING.md).

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
- llama.cpp, wllama, the Emscripten runtime, the Dawn WebGPU library, and Svelte: see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- `scripts/bench/fixtures/kyoto.html` is a CC BY-SA 4.0 Wikipedia derivative. It is not covered by the MIT license and is not part of the extension package.

Japanese documentation: [README.ja.md](README.ja.md).
