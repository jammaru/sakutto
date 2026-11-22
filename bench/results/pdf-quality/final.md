| label | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| final | 5 | 1 | 1.3% | 0.0% | 0.04% | 0.000 | 0.099 | 98.3% | 342 | 1029 |

"skipped prose" counts code/label blocks the layout skipped that still contain a natural-language sentence; they are part of the prose denominator and the untranslated rate. Proper names and page furniture are deliberately kept in the source and are reported separately, not counted as translation failures.

## Text source split

The scan fixture above is SIMULATED OCR: scan.pdf supplies the page size and background, but word boxes are synthesized from paper.pdf text. It measures OCR layout and placement, not recognition. Real recognition on scan.pdf is measured separately with pnpm bench:pdf:scan:ocr and listed below; never read the simulated scan row as a real-scan result.

| text source           | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box |
| --------------------- | ----: | ------------: | -----------------: | -------------: | -------------: | ----------: | -----------: |
| native (paper, arxiv) |     4 |             0 |               0.0% |           0.0% |          0.05% |       0.000 |        0.000 |
| simulated OCR (scan)  |     1 |             1 |               4.2% |           0.0% |          0.00% |       0.000 |        0.333 |

## Real OCR on scan.pdf page 1 (pnpm bench:pdf:scan:ocr)

| variant            |   CER |   WER | lines | blocks | skipped | cross-column | overlaps | overflow |
| ------------------ | ----: | ----: | ----: | -----: | ------: | -----------: | -------: | -------: |
| baseline-1x        | 0.680 | 0.946 |    99 |     46 |      12 |            1 |        0 |        0 |
| dpi200             | 0.202 | 0.376 |   111 |     60 |       5 |            1 |        0 |        0 |
| shipped-baseline   | 0.116 | 0.168 |   105 |     60 |       7 |            9 |        0 |        0 |
| default-1600       | 0.030 | 0.055 |   117 |     52 |       7 |            0 |        0 |        0 |
| dpi300             | 0.030 | 0.055 |   116 |     53 |       3 |            0 |        0 |        0 |
| sauvola            | 0.826 | 0.972 |    94 |     33 |      22 |            7 |        0 |        0 |
| dpi200+sauvola     | 0.694 | 0.941 |   100 |     44 |      14 |            3 |        0 |        0 |
| dpi200+gray        | 0.223 | 0.406 |   110 |     55 |       5 |            7 |        0 |        0 |
| gray+contrast      | 0.212 | 0.369 |   112 |     58 |       9 |            9 |        0 |        0 |
| gray+contrast-1600 | 0.030 | 0.054 |   117 |     60 |       4 |            0 |        0 |        0 |
| contrast           | 0.208 | 0.360 |   112 |     58 |       9 |            9 |        0 |        0 |
| otsu               | 0.700 | 0.941 |   100 |     44 |      17 |            6 |        0 |        0 |
| denoise            | 0.727 | 0.958 |   100 |     27 |      22 |            1 |        0 |        0 |
| trim               | 0.199 | 0.368 |   110 |     59 |       5 |            1 |        0 |        0 |
| box-0.35           | 0.202 | 0.376 |   111 |     60 |       5 |            1 |        0 |        0 |
| box-0.55           | 0.202 | 0.375 |   111 |     59 |       6 |            1 |        0 |        0 |
| unclip-1.8         | 0.361 | 0.578 |   102 |     56 |       7 |            2 |        0 |        0 |
