# Third-party notices

Checked 2026-11-05. This is an inventory of licenses found in the tree and in the current upstream sources. It is not a legal clearance.

The extension package is not "MIT only." MIT applies to the original project code. Other licenses stay attached to the files they cover. `NOTICE` is the short text copied into the zip. This file is the longer inventory and is not packaged, because `scripts/verify-package.ts` rejects `.md` in the zip.

## What the MIT grant covers

`LICENSE` is the MIT license, Copyright (c) 2026 jammaru. It covers the original code in this repository. It does not relicense:

- PLaMo 3 Translate weights, tokenizer, or model card
- `scripts/bench/fixtures/kyoto.html`
- bundled wllama, llama.cpp, Emscripten, Dawn, Svelte, or ONNX Runtime
- PP-OCRv6 weights or character dictionary
- bundled pdf.js, its CMaps, or its standard font substitutes

## Shipped in the extension zip

| Item                                                 | License                                                                   | Where it is proved                                                                                                                            | Zip                                          | Status                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Project code                                         | MIT, Copyright 2026 jammaru                                               | `LICENSE`, copied to `licenses/LICENSE.txt`                                                                                                   | yes                                          | notice included                                                                     |
| wllama `d275dac17bc7f190161deb24fd834ce03342e2bc`    | MIT, Copyright (c) 2024 Xuan Son NGUYEN                                   | upstream `LICENCE` matched `licenses/wllama-LICENSE.txt` byte for byte on 2026-11-05. `package.json` at that commit says MIT, version 3.12.0  | yes, after `pnpm build:wllama`               | notice included                                                                     |
| llama.cpp `5aeac37a35b44fde4bdffaec9159f2fcb253b622` | MIT, Copyright (c) 2023-2026 The ggml authors                             | upstream `LICENSE` matched `licenses/llama.cpp-LICENSE.txt` byte for byte                                                                     | compiled into the wasm                       | notice included                                                                     |
| Emscripten runtime                                   | MIT and University of Illinois/NCSA                                       | `licenses/emscripten-LICENSE.txt`                                                                                                             | linked into the wasm                         | notice included                                                                     |
| Dawn emdawnwebgpu JavaScript library                 | BSD-3-Clause, Copyright 2017-2026 The Dawn & Tint Authors                 | `licenses/dawn-LICENSE.txt`. The file says other Dawn licenses are not part of the bundled library                                            | linked into the build                        | notice included. BSD-3 also forbids using the authors' names to endorse the product |
| Svelte 5.57.3                                        | MIT, Copyright (c) 2016-2025 Svelte Contributors                          | npm tarball `svelte-5.57.3.tgz`, `package/LICENSE.md`, copied to `licenses/svelte-LICENSE.txt`                                                | compiled UI                                  | notice added                                                                        |
| WXT 0.21.5                                           | MIT in `package.json`. Author field: Aaron Klinker                        | tarball `wxt-0.21.5.tgz` contains `package.json` and `README.md` only, no LICENSE file                                                        | `wxt/browser` is imported                    | notice in `NOTICE`. No upstream license file exists to copy                         |
| PLaMo Community License, Japanese and English        | PLaMo Community License, not MIT                                          | `licenses/PLaMo-Community-License-*.txt`. English and Japanese pages matched the articles on 2026-11-05                                       | yes                                          | required when model materials are provided to others                                |
| Icons                                                | original artwork from `scripts/generate-icons.mjs` and `scripts/icon.svg` | no third-party icon font or image                                                                                                             | `icon/16.png`, `32.png`, `48.png`, `128.png` | no extra notice found                                                               |
| UI fonts                                             | system font stack in `src/ui/tokens.css`                                  | no `@font-face`, no font files                                                                                                                | none                                         | no font license                                                                     |
| Sample page                                          | original sentences in `src/entrypoints/sample/index.html`                 | not Wikipedia                                                                                                                                 | `sample.html`                                | project content                                                                     |
| ONNX Runtime Web 1.31.1                              | MIT, Copyright (c) Microsoft Corporation                                  | npm package declares MIT; `licenses/onnxruntime-LICENSE.txt`; WASM size/SHA-256 pins in `src/engine/ocr/runtime-assets.ts`                    | yes, local `ocr/ort/`                        | notice included; no remote WASM                                                     |
| PP-OCRv6 character dictionary                        | Apache-2.0, PaddlePaddle authors                                          | PaddleOCR 3.7.0 `ppocr/utils/dict/ppocrv6_dict.txt`, 74,947 bytes, SHA-256 `b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d` | yes, `ocr/pp-ocrv6-chars.txt`                | PaddleOCR license included                                                          |
| pdf.js (`pdfjs-dist` 4.10.38)                        | Apache-2.0, Copyright Mozilla Foundation                                  | npm tarball `pdfjs-dist-4.10.38.tgz`, `LICENSE`, copied to `vendor/pdfjs/LICENSE-pdfjs.txt`                                                   | yes, after `pnpm pdfjs`                      | notice included                                                                     |
| pdf.js CMaps (169 `.bcmap` files)                    | Adobe character maps, redistributed by pdf.js                             | `cmaps/LICENSE` copied to `vendor/pdfjs/LICENSE-cmaps.txt`                                                                                    | yes                                          | notice included                                                                     |
| pdf.js standard font substitutes                     | Foxit (`.pfb`) and Liberation (`.ttf`)                                    | `standard_fonts/LICENSE_FOXIT` and `LICENSE_LIBERATION`, copied into `vendor/pdfjs/`                                                          | yes                                          | notices included                                                                    |

`pnpm-lock.yaml` devDependencies (ESLint, Prettier, Vitest, Playwright, TypeScript, Vite, and the rest) are used to build and test. `scripts/verify-package.ts` rejects `node_modules/` in the zip. They are not runtime payload. Their licenses were not each opened. Anyone who runs `pnpm install` receives those packages under their own licenses.

## Downloaded at runtime, not in the zip

| Item                                 | Source checked 2026-11-06                                                                                                                                                                                                       | License                                                                                                      | In the zip                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `plamo-3-translate-0.8b-Q4_K_M.gguf` | repo `pfnet/plamo-3-translate-0.8b-GGUF`, commit `dbeb0856cb0b004b484f190bb71dd65876297013`. API `gated: false`, `private: false`. Size `573123200`. SHA-256 `923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd` | `license_name: plamo-community-license`, link `https://plamo.preferredai.jp/info/plamo-community-license-en` | no. `.gguf` fails the package check |
| `plamo-3-translate-2b-Q4_K_M.gguf`   | repo `pfnet/plamo-3-translate-2b-GGUF`, commit `232fbd7916519edecddfdae0beae7e76fe70453f`. Same public, ungated result. Size `1807199392`. SHA-256 `f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0`           | same community license                                                                                       | no                                  |
| `PP-OCRv6_tiny_det.onnx`             | `PaddlePaddle/PP-OCRv6_tiny_det_onnx`, commit `2ba1506c0380b8f0b03dd142459aac66d4421f6c`. Size `1780590`. SHA-256 `193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8`                                            | Apache-2.0                                                                                                   | no                                  |
| `PP-OCRv6_small_det.onnx`            | `PaddlePaddle/PP-OCRv6_small_det_onnx`, commit `28fe5895c24fd108c19eb3e8479f4ab385fbfc62`. Size `9880512`. SHA-256 `d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e`                                           | Apache-2.0                                                                                                   | no                                  |
| `PP-OCRv6_medium_det.onnx`           | `PaddlePaddle/PP-OCRv6_medium_det_onnx`, commit `61323801669c338b7891481ec7bac61ce31b576a`. Size `62032837`. SHA-256 `eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1`                                         | Apache-2.0                                                                                                   | no                                  |
| `PP-OCRv6_small_rec.onnx`            | `PaddlePaddle/PP-OCRv6_small_rec_onnx`, commit `b8f84f0b80c529de40b4fbb3544b84fa7233a513`. Size `21159378`. SHA-256 `5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634`                                          | Apache-2.0                                                                                                   | no                                  |
| `PP-OCRv6_medium_rec.onnx`           | `PaddlePaddle/PP-OCRv6_medium_rec_onnx`, commit `50c7eacafc52fa7bcf4194e8cd08e46f8558504b`. Size `76554979`. SHA-256 `9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba`                                         | Apache-2.0                                                                                                   | no                                  |

Each PP-OCRv6 file was downloaded from its pinned Hugging Face URL and hashed locally; the byte count and digest also match the Hugging Face LFS metadata. `tiny_rec` is deliberately absent because this integration requires the full Japanese-kana dictionary shared by small and medium recognition. PaddleOCR's Apache-2.0 text is in `licenses/PaddleOCR-Apache-2.0.txt`.

Both files are published by `pfnet` as quantized GGUF (`base_model_relation: quantized`). This project does not quantize them and does not rehost them. The extension only requests the pinned URL (`src/engine/model/catalog.ts`).

The model is used under the PLaMo Community License (`https://plamo.preferredai.jp/info/plamo-community-license-en`, Japanese: `https://plamo.preferredai.jp/info/plamo-community-license-ja`). Hugging Face `LICENSE/en` and `LICENSE/ja` omit some Article 4 and Article 6 items that remain on preferredai.jp; this repository ships the preferredai.jp copies. PLaMo API/Chat terms and the hosted PLaMo Translate service terms do not govern these GGUF files.

## Not shipped: generated OCR benchmark fixtures

`bench/ocr/fixtures/` contains deterministic English/Japanese SVG, PNG, and raw-RGBA benchmark inputs covering scans, horizontal and vertical Japanese, slides, low-resolution/skew, columns, mixed text, and small text. The source sentences and generated images are dedicated to CC0; attribution and regeneration details are in `bench/ocr/LICENSE.md`. They are not packaged in the extension.

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

Article 4 requires a copy of the agreement (bundled), the words "Built with PLaMo" (in the UI, the store's detailed description, and the docs), "PLaMo" in the name of an AI model created from the materials (this extension does not create a new model), and compliance with any other license on a component. "Built with PLaMo" is attribution required by that article. The store summary and the manifest description do not carry it.

Article 5 requires a public translation to be identified as model output. The UI labels PLaMo output as machine translation.

## wllama remote-code note

At the pinned commit, `src/wasm-from-cdn.ts` contains `https://cdn.jsdelivr.net/npm/@wllama/wllama@3.12.0/...` URLs. The MV3 patch removes that import from the constructor. `src/engine/in-browser/runtime.ts` loads a local `Blob` through `loadModel`, not `loadModelFromUrl` or `loadModelFromHF`. `loadWllamaModule` refuses a URL outside the extension origin. `scripts/verify-package.ts` fails the zip if `cdn.jsdelivr.net` appears in packaged `.js`, `.mjs`, or `.html`. Unused `loadModelFromUrl` / `loadModelFromHF` methods remain in the library bundle.
