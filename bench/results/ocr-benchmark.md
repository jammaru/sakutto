# PP-OCRv6 Node/WASM benchmark

Generated: 2026-11-21T17:53:55.624Z  
Runtime: Node v24.11.0, onnxruntime-web 1.31.1, WASM, 1 thread, Intel(R) Xeon(R) Processor  
Fixtures: **generated CC0**; manifest SHA-256 c77dd8691c5dc2a9c418bda3c2f5b7297861d8ada7d14d1bd979a06e5c92eeea

## Pairing summary

| Pairing               | micro CER | micro WER | macro detection recall proxy | mean wall ms/page | practical / marginal / not |
| --------------------- | --------: | --------: | ---------------------------: | ----------------: | -------------------------: |
| tiny_det+small_rec    |      0.7% |      7.3% |                       100.0% |            1208.1 |                  8 / 0 / 0 |
| small_det+small_rec   |      3.5% |     10.9% |                       100.0% |            1530.8 |                  7 / 1 / 0 |
| medium_det+medium_rec |      0.4% |      4.2% |                       100.0% |            7795.3 |                  8 / 0 / 0 |

**Recommended default:** tiny_det+small_rec — fastest pairing within 0.05 absolute micro-CER and 0.05 absolute macro detection-recall proxy of the best values. This is a benchmark recommendation only; DEFAULT_OCR_TIER was not changed.

## Every pairing and case

| Pairing               | Case          |   CER |   WER | Detection matched | Wall ms | Practicality |
| --------------------- | ------------- | ----: | ----: | ----------------: | ------: | ------------ |
| tiny_det+small_rec    | en-scan       |  0.0% |  0.0% |               7/7 |  1351.3 | practical    |
| tiny_det+small_rec    | ja-horizontal |  0.0% |  0.0% |               6/6 |  1221.3 | practical    |
| tiny_det+small_rec    | ja-vertical   |  0.0% |  0.0% |               5/5 |   879.4 | practical    |
| tiny_det+small_rec    | slides        |  0.0% |  0.0% |               6/6 |  1089.9 | practical    |
| tiny_det+small_rec    | low-res-skew  |  0.0% |  0.0% |               6/6 |  1038.5 | practical    |
| tiny_det+small_rec    | two-column    |  0.0% |  0.0% |               8/8 |  1535.6 | practical    |
| tiny_det+small_rec    | mixed-ja-en   |  6.9% | 75.0% |               6/6 |  1123.6 | practical    |
| tiny_det+small_rec    | small-text    |  0.0% |  0.0% |               8/8 |  1424.9 | practical    |
| small_det+small_rec   | en-scan       |  0.0% |  0.0% |               7/7 |  1691.4 | practical    |
| small_det+small_rec   | ja-horizontal |  0.0% |  0.0% |               6/6 |  1481.5 | practical    |
| small_det+small_rec   | ja-vertical   |  0.0% |  0.0% |               5/5 |  1167.4 | practical    |
| small_det+small_rec   | slides        | 24.6% | 30.0% |               6/6 |  1484.5 | marginal     |
| small_det+small_rec   | low-res-skew  |  0.0% |  0.0% |               6/6 |  1412.9 | practical    |
| small_det+small_rec   | two-column    |  0.0% |  0.0% |               8/8 |  1809.6 | practical    |
| small_det+small_rec   | mixed-ja-en   |  6.9% | 75.0% |               6/6 |  1435.8 | practical    |
| small_det+small_rec   | small-text    |  0.0% |  0.0% |               8/8 |  1763.1 | practical    |
| medium_det+medium_rec | en-scan       |  0.0% |  0.0% |               7/7 |  8302.0 | practical    |
| medium_det+medium_rec | ja-horizontal |  0.0% |  0.0% |               6/6 |  7788.3 | practical    |
| medium_det+medium_rec | ja-vertical   |  0.0% |  0.0% |               5/5 |  6010.4 | practical    |
| medium_det+medium_rec | slides        |  0.0% |  0.0% |               6/6 |  7740.1 | practical    |
| medium_det+medium_rec | low-res-skew  |  0.0% |  0.0% |               6/6 |  6934.9 | practical    |
| medium_det+medium_rec | two-column    |  0.0% |  0.0% |               8/8 |  9277.7 | practical    |
| medium_det+medium_rec | mixed-ja-en   |  3.4% | 43.8% |               6/6 |  7234.6 | practical    |
| medium_det+medium_rec | small-text    |  0.0% |  0.0% |               8/8 |  9074.7 | practical    |

## Measurement definitions

- **detectionPreprocess:** {"maxSide":960,"multiple":32}
- **recognitionPreprocess:** {"height":48,"maxWidth":4096}
- **detection:** threshold=0.2; boxThreshold=0.4 tiny_det, 0.45 otherwise; unclipRatio=1.4; minSize=3; maxCandidates=3000; verticalRatio=1.5
- **timing:** Wall milliseconds include existing pure preprocessing, DB decode/crops, ONNX detect+recognize, CTC and ordering. Model initialization and one en-scan warm-up per pairing are excluded.
- **cer:** Levenshtein edits / reference Unicode code points after NFC and folding all whitespace runs to one ASCII space; trimmed.
- **wer:** Levenshtein edits / reference whitespace-delimited tokens after the same normalization; Japanese has no morphological tokenization.
- **detectionRecallProxy:** Maximum-IoU-first greedy one-to-one matching of axis-aligned bounding boxes of GT and predicted quads; matched GT boxes with IoU >= 0.30 / all GT boxes. Proxy only: no polygon IoU or precision.
- **practicality:** practical: recall>=0.80 and CER<=0.15; marginal: recall>=0.50 and CER<=0.40; otherwise not practical.
- **WER caveat:** whitespace tokenization makes Japanese WER coarse; CER is the primary Japanese accuracy measure.
- **Initialization:** tiny_det+small_rec=397.7ms, small_det+small_rec=155.5ms, medium_det+medium_rec=502.2ms. Page timings exclude initialization and warm-up.

## OCR → translation plumbing sanity

These records use the **actual OCR output** below through a deterministic local replacement stub. They test plumbing only and are **not translation-quality results**. Full OCR and stub text is in ocr-benchmark.json.

### tiny_det+small_rec / en-scan

OCR SHA-256: a486c19fd989cc8934020cd67c6c1fce3965e9eed6a75d3bcae7e839febc9d51

[SANITY STUB] ローカル 翻訳 NOTES
A プライベート tool for every reader.
Open a page and choose a 言語.
The テキスト stays on this 端末.
No アカウント is required.
Version 2.4 March 2026
Please keep this receipt.

### tiny_det+small_rec / ja-horizontal

OCR SHA-256: 97988987f857d2f2e15237a93f4cd874c7af6c3033698dd1335ec523c5790656

[SANITY STUB] ローカルtranslationのご案内
この文章はdeviceの中でprocessingします。
translationするlanguageを選んでください。
imageからtextを読み取ります。
resultをcheckしてから共有できます。
静かな場所でも利用できます。

### small_det+small_rec / en-scan

OCR SHA-256: a486c19fd989cc8934020cd67c6c1fce3965e9eed6a75d3bcae7e839febc9d51

[SANITY STUB] ローカル 翻訳 NOTES
A プライベート tool for every reader.
Open a page and choose a 言語.
The テキスト stays on this 端末.
No アカウント is required.
Version 2.4 March 2026
Please keep this receipt.

### small_det+small_rec / ja-horizontal

OCR SHA-256: 97988987f857d2f2e15237a93f4cd874c7af6c3033698dd1335ec523c5790656

[SANITY STUB] ローカルtranslationのご案内
この文章はdeviceの中でprocessingします。
translationするlanguageを選んでください。
imageからtextを読み取ります。
resultをcheckしてから共有できます。
静かな場所でも利用できます。

### medium_det+medium_rec / en-scan

OCR SHA-256: a486c19fd989cc8934020cd67c6c1fce3965e9eed6a75d3bcae7e839febc9d51

[SANITY STUB] ローカル 翻訳 NOTES
A プライベート tool for every reader.
Open a page and choose a 言語.
The テキスト stays on this 端末.
No アカウント is required.
Version 2.4 March 2026
Please keep this receipt.

### medium_det+medium_rec / ja-horizontal

OCR SHA-256: 97988987f857d2f2e15237a93f4cd874c7af6c3033698dd1335ec523c5790656

[SANITY STUB] ローカルtranslationのご案内
この文章はdeviceの中でprocessingします。
translationするlanguageを選んでください。
imageからtextを読み取ります。
resultをcheckしてから共有できます。
静かな場所でも利用できます。

## Reproduce

    node --experimental-strip-types --no-warnings --import ./scripts/bench/register-ts.mjs scripts/bench/ocr-render.ts
    node --experimental-strip-types --no-warnings --import ./scripts/bench/register-ts.mjs scripts/bench/ocr-run.ts
    pnpm vitest run --configLoader runner tests/ocr-bench.test.ts
    OCR_BENCH_SMOKE=1 pnpm vitest run --configLoader runner tests/ocr-bench.test.ts

No existing source file or DEFAULT_OCR_TIER was changed.
