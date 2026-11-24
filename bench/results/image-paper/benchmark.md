# Image-only two-column paper: before / after

Fixture: `bench/pdf/image-only-paper.pdf` (2 pages). Machine: Linux x86_64, Node 24,
headless Chromium, ONNX Runtime 1.31.1 **WASM CPU** (no WebGPU adapter in this environment).
Raw numbers: `benchmark.json`, `before-metric.json`, `after.json`.

| page | before OCR | after OCR | before first visible | after first visible | before OCR+translate | after OCR+translate | before cross-column | after cross-column |
| ---- | ---------: | --------: | -------------------: | ------------------: | -------------------: | ------------------: | ------------------: | -----------------: |
| 1    |    8892 ms |   8659 ms |         not observed |               12 ms |              8899 ms |             8674 ms |                   0 |                  0 |
| 2    |    7777 ms |   7905 ms |                10 ms |                3 ms |              7790 ms |             7912 ms |                   2 |                  0 |

- OCR is one warmed run of the shipped Standard pair (`tiny_det` + `small_rec`) at detection
  maxSide 1600; it dominates the page time. CPU inference speed is unchanged by this change.
- Translation uses a deterministic fake engine with one macrotask per delta, so the recorded
  first-visible/full numbers measure reader plumbing (streaming paint, fit, overlap pass), not
  model decoding. Translation was already block-by-block; the new hook makes it observable.
- Speed work that does not show up in a single cold page run: per-page OCR cache (no re-OCR when
  scrolling back), one idle-time page/extract prefetch (no extra canvas or OCR work), streaming
  first-paint, ORT graph optimisation and a capability-probed WebGPU provider with WASM fallback.
- `/opt/cursor/artifacts` is read-only in this sandbox. After screenshots are committed at
  `bench/results/image-paper/after-p1.png` and `after-p2.png`.

## scan.pdf regression

`pnpm bench:pdf:scan:ocr -- --variants default-1600`: CER **0.030** (<= 0.05),
crossColumnCovers **0**, overlapPairs 0. No accuracy regression from the column changes.
