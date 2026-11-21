# PP-OCRv6 Node/WASM benchmark

Generated: 2026-11-21T16:09:23.442Z  
Runtime: Node v24.22.3, onnxruntime-web 1.31.1, WASM, 1 thread, Intel(R) Xeon(R) Processor  
Fixtures: **generated CC0**; manifest SHA-256 c77dd8691c5dc2a9c418bda3c2f5b7297861d8ada7d14d1bd979a06e5c92eeea

## Pairing summary

| Pairing               | micro CER | micro WER | macro detection recall proxy | mean wall ms/page | practical / marginal / not |
| --------------------- | --------: | --------: | ---------------------------: | ----------------: | -------------------------: |
| tiny_det+small_rec    |      0.3% |      2.4% |                       100.0% |             769.0 |                  8 / 0 / 0 |
| small_det+small_rec   |      3.1% |      6.1% |                       100.0% |            1082.9 |                  7 / 1 / 0 |
| medium_det+medium_rec |     10.3% |     20.6% |                       100.0% |            5835.8 |                  6 / 2 / 0 |

**Recommended default:** tiny_det+small_rec — fastest pairing within 0.05 absolute micro-CER and 0.05 absolute macro detection-recall proxy of the best values. This is a benchmark recommendation only; DEFAULT_OCR_TIER was not changed.

## Every pairing and case

| Pairing               | Case          |   CER |   WER | Detection matched | Wall ms | Practicality |
| --------------------- | ------------- | ----: | ----: | ----------------: | ------: | ------------ |
| tiny_det+small_rec    | en-scan       |  0.0% |  0.0% |               7/7 |   831.4 | practical    |
| tiny_det+small_rec    | ja-horizontal |  0.0% |  0.0% |               6/6 |   742.9 | practical    |
| tiny_det+small_rec    | ja-vertical   |  0.0% |  0.0% |               5/5 |   695.4 | practical    |
| tiny_det+small_rec    | slides        |  0.0% |  0.0% |               6/6 |   720.1 | practical    |
| tiny_det+small_rec    | low-res-skew  |  0.0% |  0.0% |               6/6 |   701.5 | practical    |
| tiny_det+small_rec    | two-column    |  0.0% |  0.0% |               8/8 |   866.9 | practical    |
| tiny_det+small_rec    | mixed-ja-en   |  2.6% | 25.0% |               6/6 |   716.5 | practical    |
| tiny_det+small_rec    | small-text    |  0.0% |  0.0% |               8/8 |   877.4 | practical    |
| small_det+small_rec   | en-scan       |  0.0% |  0.0% |               7/7 |  1108.4 | practical    |
| small_det+small_rec   | ja-horizontal |  0.0% |  0.0% |               6/6 |  1024.1 | practical    |
| small_det+small_rec   | ja-vertical   |  0.0% |  0.0% |               5/5 |   954.1 | practical    |
| small_det+small_rec   | slides        | 24.6% | 30.0% |               6/6 |  1068.2 | marginal     |
| small_det+small_rec   | low-res-skew  |  0.0% |  0.0% |               6/6 |  1028.9 | practical    |
| small_det+small_rec   | two-column    |  0.0% |  0.0% |               8/8 |  1233.6 | practical    |
| small_det+small_rec   | mixed-ja-en   |  2.6% | 25.0% |               6/6 |  1023.0 | practical    |
| small_det+small_rec   | small-text    |  0.0% |  0.0% |               8/8 |  1223.0 | practical    |
| medium_det+medium_rec | en-scan       | 35.9% | 55.9% |               7/7 |  5899.9 | marginal     |
| medium_det+medium_rec | ja-horizontal |  0.0% |  0.0% |               6/6 |  5610.6 | practical    |
| medium_det+medium_rec | ja-vertical   |  0.0% |  0.0% |               5/5 |  5253.2 | practical    |
| medium_det+medium_rec | slides        |  0.8% | 10.0% |               6/6 |  5700.0 | practical    |
| medium_det+medium_rec | low-res-skew  |  0.0% |  0.0% |               6/6 |  5567.1 | practical    |
| medium_det+medium_rec | two-column    |  0.0% |  0.0% |               8/8 |  6540.9 | practical    |
| medium_det+medium_rec | mixed-ja-en   |  0.9% | 12.5% |               6/6 |  5594.3 | practical    |
| medium_det+medium_rec | small-text    | 19.9% | 34.4% |               8/8 |  6520.5 | marginal     |

## Measurement definitions

- **detectionPreprocess:** {"maxSide":960,"multiple":32}
- **recognitionPreprocess:** {"height":48,"maxWidth":320}
- **detection:** threshold=0.2; boxThreshold=0.4 tiny_det, 0.45 otherwise; unclipRatio=1.4; minSize=3; maxCandidates=3000; verticalRatio=1.5
- **timing:** Wall milliseconds include existing pure preprocessing, DB decode/crops, ONNX detect+recognize, CTC and ordering. Model initialization and one en-scan warm-up per pairing are excluded.
- **cer:** Levenshtein edits / reference Unicode code points after NFC and folding all whitespace runs to one ASCII space; trimmed.
- **wer:** Levenshtein edits / reference whitespace-delimited tokens after the same normalization; Japanese has no morphological tokenization.
- **detectionRecallProxy:** Maximum-IoU-first greedy one-to-one matching of axis-aligned bounding boxes of GT and predicted quads; matched GT boxes with IoU >= 0.30 / all GT boxes. Proxy only: no polygon IoU or precision.
- **practicality:** practical: recall>=0.80 and CER<=0.15; marginal: recall>=0.50 and CER<=0.40; otherwise not practical.
- **WER caveat:** whitespace tokenization makes Japanese WER coarse; CER is the primary Japanese accuracy measure.
- **Initialization:** tiny_det+small_rec=343.9ms, small_det+small_rec=114.6ms, medium_det+medium_rec=398.1ms. Page timings exclude initialization and warm-up.

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

OCR SHA-256: 8717eafbfe917ab5625b69fdfcf91ef49837b7a0247fe817d19806b6452b5f34

[SANITY STUB] ローカル 翻訳 NOTES
vvyd.
On apage aage.
Theynv.
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
