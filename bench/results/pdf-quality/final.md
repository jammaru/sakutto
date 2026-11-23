| label | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block from page ms | first block from run ms | full ms |
| ----- | ----: | ------------: | -----------------: | -------------: | -------------: | ----------: | -----------: | ------------: | -----------------------: | ----------------------: | ------: |
| final |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        6 |                     299 |     941 |

"skipped prose" counts code/label blocks the layout skipped that still contain a natural-language sentence; they are part of the prose denominator and the untranslated rate. Proper names and page furniture are deliberately kept in the source and are reported separately, not counted as translation failures.

## Text source split

The scan fixture above is SIMULATED OCR: scan.pdf supplies the page size and background, but word boxes are synthesized from paper.pdf text. It measures OCR layout and placement, not recognition. Real recognition on scan.pdf is measured separately with pnpm bench:pdf:scan:ocr and listed below; never read the simulated scan row as a real-scan result.

| text source           | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box |
| --------------------- | ----: | ------------: | -----------------: | -------------: | -------------: | ----------: | -----------: |
| native (paper, arxiv) |     4 |             0 |               0.0% |           0.0% |          0.05% |       0.000 |        0.000 |
| simulated OCR (scan)  |     1 |             0 |               0.0% |           0.0% |          0.00% |       0.000 |        0.080 |

## Real OCR on scan.pdf page 1 (pnpm bench:pdf:scan:ocr)

| variant            |   CER |   WER | lines | blocks | skipped | cross-column | overlaps | overflow |
| ------------------ | ----: | ----: | ----: | -----: | ------: | -----------: | -------: | -------: |
| baseline-1x        | 0.667 | 0.948 |   100 |     43 |       9 |            0 |        0 |       18 |
| dpi200             | 0.202 | 0.376 |   111 |     56 |       4 |            0 |        0 |       15 |
| shipped-baseline   | 0.116 | 0.168 |   105 |     57 |       7 |            0 |        0 |       22 |
| default-1600       | 0.030 | 0.055 |   117 |     48 |       6 |            0 |        0 |        4 |
| dpi300             | 0.054 | 0.076 |   115 |     50 |       3 |            0 |        0 |        6 |
| sauvola            | 0.825 | 0.972 |    97 |     34 |      15 |            2 |        0 |       15 |
| dpi200+sauvola     | 0.686 | 0.937 |   103 |     61 |       6 |            0 |        0 |       28 |
| dpi200+gray        | 0.245 | 0.425 |   109 |     51 |       4 |            0 |        0 |       15 |
| gray+contrast      | 0.230 | 0.386 |   111 |     53 |       8 |            0 |        0 |       15 |
| gray+contrast-1600 | 0.054 | 0.075 |   116 |     57 |       4 |            0 |        0 |        7 |
| contrast           | 0.227 | 0.379 |   111 |     53 |       8 |            0 |        0 |       15 |
| otsu               | 0.689 | 0.941 |   104 |     39 |      14 |            0 |        0 |       13 |
| denoise            | 0.724 | 0.957 |   104 |     22 |      19 |            0 |        0 |        5 |
| trim               | 0.220 | 0.386 |   109 |     56 |       5 |            0 |        0 |       17 |
| box-0.35           | 0.202 | 0.376 |   111 |     56 |       4 |            0 |        0 |       15 |
| box-0.55           | 0.202 | 0.375 |   111 |     56 |       4 |            0 |        0 |       15 |
| unclip-1.8         | 0.361 | 0.578 |   102 |     54 |       5 |            0 |        0 |       28 |
