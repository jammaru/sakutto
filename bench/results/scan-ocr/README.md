# Real OCR on `bench/pdf/scan.pdf` page 1

## Root cause of the old CER

The previous bench compared OCR text against **paper.pdf page 1** text. scan.pdf is not a print render:
`build-pdf-fixtures.ts` screenshots paper.html as a screen page (1240x1754) and packs the JPEGs into an
image-only PDF. The document is one page tall, so scan p1 contains the entire article in two CSS
columns, while paper.pdf p1 is a shorter print page with margins and different breaks. The reference
was therefore misaligned and CER ~1.4 measured layout mismatch, not recognition.

## Ground truth

`bench/pdf/scan-p1.gt.txt` is the committed, reading-ordered transcription of the scan raster (1,698
words / 9,892 characters). It is regenerated with
`scripts/bench/build-scan-gt.ts`, which reads the visible words from the same DOM the scan was
captured from and orders title, abstract, left body column, right body column and references.

## What is measured

- **CER / WER**: Levenshtein error rates after NFC + whitespace folding. OCR lines are content-aligned
  to the nearest unused GT line (word overlap) before scoring, so the number measures character
  recognition rather than column order. Unmatched words still count as errors.
- **line order**: match-based adjacent accuracy on the _product_ output, with a coverage penalty;
  a one-line hypothesis can no longer score 100% against an eight-line reference.
- **coverage**: word-level LCS share of GT words present in the hypothesis in order.
- **cross-column**: painted covers that cross a column gutter in the reader layout.
- **model bytes**: pinned model file sizes actually loaded by the pipeline.

## Latest results (Standard, tiny_det + small_rec)

| approach           | pairing            |   CER |   WER | cross-column | ms/page | model bytes | coverage |
| ------------------ | ------------------ | ----: | ----: | -----------: | ------: | ----------: | -------: |
| baseline-1x        | tiny_det+small_rec | 66.7% | 94.8% |            0 |  24.2 s |    21.9 MiB |    0.110 |
| shipped-baseline   | tiny_det+small_rec | 11.6% | 16.8% |            0 |  29.1 s |    21.9 MiB |    0.885 |
| default-1600       | tiny_det+small_rec |  3.0% |  5.5% |            0 |  37.6 s |    21.9 MiB |    0.963 |
| gray+contrast-1600 | tiny_det+small_rec |  5.4% |  7.5% |            0 |  35.8 s |    21.9 MiB |    0.953 |
| dpi300             | tiny_det+small_rec |  5.4% |  7.6% |            0 |  37.5 s |    21.9 MiB |    0.953 |
| sauvola            | tiny_det+small_rec | 82.5% | 97.2% |            2 |  23.1 s |    21.9 MiB |    0.030 |

The table above is copied from the current `report.md` / `report.json` run produced by `pnpm bench:pdf:scan:ocr`; `iteration6.md` / `iteration6.json` record the earlier iteration-6 run with different timings and cross-column counts. Default 2x / maxSide 1600 reaches **3.0% CER** on the latest recommitted run (recognition varies slightly
between runs); `dpi300` is similar CER with more time. Cross-column counts follow the committed
`report.json` row and move with layout fixes.
Binarization (Sauvola/Otsu) destroys the small serif glyphs of this scan. Keeping the engine's own
reading-line grouping (instead of re-grouping after quad mapping) and splitting merged column rows
on a real gutter were the two layout fixes that removed cross-column covers.

## Model size / speed tradeoff

| approach               | pairing               |  CER | cross-column | ms/page | model bytes |
| ---------------------- | --------------------- | ---: | -----------: | ------: | ----------: |
| default-1600 (shipped) | tiny_det+small_rec    | 3.0% |            0 |  37.6 s |    21.9 MiB |
| default-1600 (high)    | medium_det+medium_rec | 3.6% |            0 | 213.7 s |   132.2 MiB |

High tier can be slightly better on CER for this page but is ~6x slower
and 6x larger; the shipped Standard tier stays the default. Its 240 s recognition bound covers this
213.7 s measurement; Standard's 60 s bound covers the committed ~34.2 s measurement. No English-specific recognizer is in the
catalog, so none was used.
