| label | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| final | 5 | 2 | 1.9% | 6.7% | 0.24% | 0.000 | 0.066 | 97.9% | 316 | 930 |

"skipped prose" counts blocks the layout skipped as code/labels that still contain a natural-language sentence; they are part of the prose denominator and the untranslated rate.

## Text source split

The scan fixture above is SIMULATED OCR: scan.pdf supplies the page size and background, but word boxes are synthesized from paper.pdf text. It measures OCR layout and placement, not recognition. Real recognition on scan.pdf is measured separately with pnpm bench:pdf:scan:ocr and listed below; never read the simulated scan row as a real-scan result.

| text source           | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box |
| --------------------- | ----: | ------------: | -----------------: | -------------: | -------------: | ----------: | -----------: |
| native (paper, arxiv) |     4 |             1 |               1.8% |           7.0% |          0.35% |       0.000 |        0.000 |
| simulated OCR (scan)  |     1 |             1 |               2.0% |           6.3% |          0.00% |       0.000 |        0.160 |

## Real OCR on scan.pdf page 1 (pnpm bench:pdf:scan:ocr)

| variant          |   CER |   WER | lines | blocks | skipped | cross-column | overlaps | overflow |
| ---------------- | ----: | ----: | ----: | -----: | ------: | -----------: | -------: | -------: |
| baseline-1x      | 0.912 | 1.783 |    58 |     53 |      10 |            6 |        0 |        0 |
| dpi200           | 1.389 | 1.725 |    69 |     68 |       3 |           10 |        0 |        0 |
| shipped-baseline | 1.461 | 1.693 |    61 |     56 |       7 |            8 |        0 |        0 |
| default-1600     | 1.411 | 1.627 |    72 |     66 |       5 |            8 |        0 |        0 |
| dpi300           | 1.412 | 1.628 |    72 |     66 |       4 |            8 |        0 |        0 |
| sauvola          | 0.725 | 0.963 |    65 |     37 |      37 |            4 |        0 |        0 |
| dpi200+sauvola   | 0.792 | 1.368 |    66 |     46 |      16 |            8 |        0 |        0 |
| dpi200+gray      | 1.400 | 1.742 |    66 |     59 |       5 |           11 |        0 |        0 |
