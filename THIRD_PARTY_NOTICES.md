# Third-party notices

Checked 2026-11-05. This is an inventory of licenses found in the tree and in the current upstream sources. It is not a legal clearance.

The extension package is not "MIT only." MIT applies to the original project code. Other licenses stay attached to the files they cover. `NOTICE` is the short text copied into the zip. This file is the longer inventory and is not packaged, because `scripts/verify-package.ts` rejects `.md` in the zip.

## What the MIT grant covers

`LICENSE` is the MIT license, Copyright (c) 2026 jammaru. It covers the original code in this repository. It does not relicense:

- PLaMo 3 Translate weights, tokenizer, or model card
- `scripts/bench/fixtures/kyoto.html`
- bundled wllama, llama.cpp, Emscripten, Dawn, or Svelte

## Shipped in the extension zip

| Item                                                 | License                                                                   | Where it is proved                                                                                                                           | Zip                                          | Status                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Project code                                         | MIT, Copyright 2026 jammaru                                               | `LICENSE`, copied to `licenses/LICENSE.txt`                                                                                                  | yes                                          | notice included                                                                     |
| wllama `d275dac17bc7f190161deb24fd834ce03342e2bc`    | MIT, Copyright (c) 2024 Xuan Son NGUYEN                                   | upstream `LICENCE` matched `licenses/wllama-LICENSE.txt` byte for byte on 2026-11-05. `package.json` at that commit says MIT, version 3.12.0 | yes, after `pnpm build:wllama`               | notice included                                                                     |
| llama.cpp `5aeac37a35b44fde4bdffaec9159f2fcb253b622` | MIT, Copyright (c) 2023-2026 The ggml authors                             | upstream `LICENSE` matched `licenses/llama.cpp-LICENSE.txt` byte for byte                                                                    | compiled into the wasm                       | notice included                                                                     |
| Emscripten runtime                                   | MIT and University of Illinois/NCSA                                       | `licenses/emscripten-LICENSE.txt`                                                                                                            | linked into the wasm                         | notice included                                                                     |
| Dawn emdawnwebgpu JavaScript library                 | BSD-3-Clause, Copyright 2017-2026 The Dawn & Tint Authors                 | `licenses/dawn-LICENSE.txt`. The file says other Dawn licenses are not part of the bundled library                                           | linked into the build                        | notice included. BSD-3 also forbids using the authors' names to endorse the product |
| Svelte 5.57.3                                        | MIT, Copyright (c) 2016-2025 Svelte Contributors                          | npm tarball `svelte-5.57.3.tgz`, `package/LICENSE.md`, copied to `licenses/svelte-LICENSE.txt`                                               | compiled UI                                  | notice added                                                                        |
| WXT 0.21.5                                           | MIT in `package.json`. Author field: Aaron Klinker                        | tarball `wxt-0.21.5.tgz` contains `package.json` and `README.md` only, no LICENSE file                                                       | `wxt/browser` is imported                    | notice in `NOTICE`. No upstream license file exists to copy                         |
| PLaMo Community License, Japanese and English        | PLaMo Community License, not MIT                                          | `licenses/PLaMo-Community-License-*.txt`. English and Japanese pages matched the articles on 2026-11-05                                      | yes                                          | required when model materials are provided to others                                |
| Icons                                                | original artwork from `scripts/generate-icons.mjs` and `scripts/icon.svg` | no third-party icon font or image                                                                                                            | `icon/16.png`, `32.png`, `48.png`, `128.png` | no extra notice found                                                               |
| UI fonts                                             | system font stack in `src/ui/tokens.css`                                  | no `@font-face`, no font files                                                                                                               | none                                         | no font license                                                                     |
| Sample page                                          | original sentences in `src/entrypoints/sample/index.html`                 | not Wikipedia                                                                                                                                | `sample.html`                                | project content                                                                     |

`pnpm-lock.yaml` devDependencies (ESLint, Prettier, Vitest, Playwright, TypeScript, Vite, and the rest) are used to build and test. `scripts/verify-package.ts` rejects `node_modules/` in the zip. They are not runtime payload. Their licenses were not each opened. Anyone who runs `pnpm install` receives those packages under their own licenses.

## Downloaded at runtime, not in the zip

| Item                                 | Source checked 2026-11-05                                                                                                                                                                                                       | License                                                                                                      | In the zip                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `plamo-3-translate-0.8b-Q4_K_M.gguf` | repo `pfnet/plamo-3-translate-0.8b-GGUF`, commit `03891e907db8a43c97d3a7c75add125cc6d1f96a`. API `gated: false`, `private: false`. Size `573116288`. SHA-256 `3dbb09295bfd3350231ba0dba92bc72cb14111ef1b034e37dad39d581bd86b9c` | `license_name: plamo-community-license`, link `https://plamo.preferredai.jp/info/plamo-community-license-en` | no. `.gguf` fails the package check |
| `plamo-3-translate-2b-Q4_K_M.gguf`   | repo `pfnet/plamo-3-translate-2b-GGUF`, commit `f2b4599dff9b3e45c62567eac15e83186b4cb64e`. Same public, ungated result. Size `1807192480`. SHA-256 `2c288ecc7ebfe60c3561726580da3583767f3c41ca3ef5c6825bf6c4cc060787`           | same community license                                                                                       | no                                  |

Both files are published by `pfnet` as quantized GGUF (`base_model_relation: quantized`). This project does not quantize them and does not rehost them. The extension only requests the pinned URL (`src/engine/model/catalog.ts`).

The model is used under the PLaMo Community License (`https://plamo.preferredai.jp/info/plamo-community-license-en`, Japanese: `https://plamo.preferredai.jp/info/plamo-community-license-ja`). Hugging Face `LICENSE/en` and `LICENSE/ja` omit some Article 4 and Article 6 items that remain on preferredai.jp; this repository ships the preferredai.jp copies. PLaMo API/Chat terms and the hosted PLaMo Translate service terms do not govern these GGUF files.

## Not shipped: Wikipedia fixture

`scripts/bench/fixtures/kyoto.html` is a modified copy of the English Wikipedia article "Kyoto."

- Authors: Wikipedia contributors
- Source: `https://en.wikipedia.org/wiki/Kyoto`
- License: CC BY-SA 4.0, `https://creativecommons.org/licenses/by-sa/4.0/`
- Changes: scripts, styles, images, and template metadata were removed. The file stays under CC BY-SA 4.0
- Packaging: the header says it is not packaged. The zip check rejects `kyoto.html` and `scripts/bench/`

`e2e/fixtures/wiki.html` is a short original test page about Osaka. It is not the Wikipedia extract. It is under `e2e/`, which the zip check rejects. It was not compared sentence by sentence with Wikipedia.

## Compatibility, without calling it clearance

MIT, MIT, NCSA, and BSD-3-Clause can be distributed together if each notice is kept. BSD-3-Clause also says the Dawn authors' names may not be used to endorse this extension. The notices do not do that.

The PLaMo Community License is a separate contract. Shipping the extension under MIT does not put the weights under MIT. The zip does not contain the weights. A person who downloads them from Hugging Face is using PFN's copy.

Article 4 requires a copy of the agreement (bundled), the words "Built with PLaMo" (in the UI, manifest description, and docs), "PLaMo" in the name of an AI model created from the materials (this extension does not create a new model), and compliance with any other license on a component. "Built with PLaMo" is attribution required by that article.

Article 5 requires a public translation to be identified as model output. The UI labels PLaMo output as machine translation.

## wllama remote-code note

At the pinned commit, `src/wasm-from-cdn.ts` contains `https://cdn.jsdelivr.net/npm/@wllama/wllama@3.12.0/...` URLs. The MV3 patch removes that import from the constructor. `src/engine/in-browser/runtime.ts` loads a local `Blob` through `loadModel`, not `loadModelFromUrl` or `loadModelFromHF`. `loadWllamaModule` refuses a URL outside the extension origin. `scripts/verify-package.ts` fails the zip if `cdn.jsdelivr.net` appears in packaged `.js`, `.mjs`, or `.html`. Unused `loadModelFromUrl` / `loadModelFromHF` methods remain in the library bundle.
