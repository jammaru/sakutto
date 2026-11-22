| label | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| final | 5 | 0 | 1.2% | 0.0% | 0.04% | 0.000 | 0.000 | 98.3% | 248 | 779 |

"skipped prose" counts code/label blocks the layout skipped that still contain a natural-language sentence; they are part of the prose denominator and the untranslated rate. Proper names and page furniture are deliberately kept in the source and are reported separately, not counted as translation failures.

## Text source split

The scan fixture above is SIMULATED OCR: scan.pdf supplies the page size and background, but word boxes are synthesized from paper.pdf text. It measures OCR layout and placement, not recognition. Real recognition on scan.pdf is measured separately with pnpm bench:pdf:scan:ocr and listed below; never read the simulated scan row as a real-scan result.

| text source           | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box |
| --------------------- | ----: | ------------: | -----------------: | -------------: | -------------: | ----------: | -----------: |
| native (paper, arxiv) |     4 |             0 |               0.0% |           0.0% |          0.05% |       0.000 |        0.000 |
| simulated OCR (scan)  |     1 |             0 |               4.0% |           0.0% |          0.00% |       0.000 |        0.000 |

## Real OCR on scan.pdf page 1 (pnpm bench:pdf:scan:ocr)

| variant            |   CER |   WER | lines | blocks | skipped | cross-column | overlaps | overflow |
| ------------------ | ----: | ----: | ----: | -----: | ------: | -----------: | -------: | -------: |
| baseline-1x        | 0.685 | 0.943 |    97 |     54 |       8 |            2 |        0 |        0 |
| dpi200             | 0.210 | 0.380 |   111 |     62 |       4 |            1 |        0 |        0 |
| shipped-baseline   | 0.116 | 0.168 |   105 |     62 |       7 |            1 |        0 |        0 |
| default-1600       | 0.030 | 0.055 |   117 |     53 |       7 |            0 |        0 |        0 |
| dpi300             | 0.030 | 0.055 |   116 |     54 |       3 |            0 |        0 |        0 |
| sauvola            | 0.825 | 0.972 |    94 |     44 |      23 |            5 |        0 |        0 |
| dpi200+sauvola     | 0.702 | 0.948 |    98 |     56 |      14 |            3 |        0 |        0 |
| dpi200+gray        | 0.217 | 0.404 |   110 |     57 |       5 |            1 |        0 |        0 |
| gray+contrast      | 0.212 | 0.368 |   111 |     58 |       8 |            1 |        0 |        0 |
| gray+contrast-1600 | 0.030 | 0.054 |   117 |     61 |       4 |            0 |        0 |        0 |
| contrast           | 0.209 | 0.359 |   111 |     58 |       8 |            1 |        0 |        0 |
| otsu               | 0.710 | 0.948 |    98 |     54 |      18 |            3 |        0 |        0 |
| denoise            | 0.726 | 0.958 |    97 |     42 |      22 |            4 |        0 |        0 |
| trim               | 0.200 | 0.368 |   110 |     65 |       4 |            1 |        0 |        0 |
| box-0.35           | 0.210 | 0.380 |   111 |     62 |       4 |            1 |        0 |        0 |
| box-0.55           | 0.210 | 0.380 |   111 |     61 |       5 |            1 |        0 |        0 |
| unclip-1.8         | 0.360 | 0.578 |   102 |     61 |       5 |            2 |        0 |        0 |
