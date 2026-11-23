| label | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block from page ms | first block from run ms | full ms |
| ----- | ----: | ------------: | -----------------: | -------------: | -------------: | ----------: | -----------: | ------------: | -----------------------: | ----------------------: | ------: |
| final |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        5 |                     300 |     920 |

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
| baseline-1x        | 0.667 | 0.948 |   100 |     43 |       9 |            1 |        0 |       18 |
| dpi200             | 0.202 | 0.376 |   111 |     56 |       4 |            1 |        0 |       15 |
| shipped-baseline   | 0.116 | 0.168 |   105 |     57 |       7 |            2 |        0 |       22 |
| default-1600       | 0.030 | 0.055 |   117 |     48 |       6 |            0 |        0 |        4 |
| dpi300             | 0.030 | 0.055 |   116 |     49 |       3 |            0 |        0 |        3 |
| sauvola            | 0.825 | 0.972 |    98 |     33 |      17 |            1 |        0 |       15 |
| dpi200+sauvola     | 0.686 | 0.936 |   104 |     60 |       6 |            1 |        0 |       27 |
| dpi200+gray        | 0.223 | 0.405 |   110 |     51 |       4 |            1 |        0 |       12 |
| gray+contrast      | 0.212 | 0.369 |   112 |     53 |       8 |            1 |        0 |       12 |
| gray+contrast-1600 | 0.030 | 0.054 |   117 |     56 |       4 |            0 |        0 |        4 |
| contrast           | 0.208 | 0.360 |   112 |     53 |       8 |            1 |        0 |       12 |
| otsu               | 0.689 | 0.941 |   104 |     38 |      15 |            1 |        0 |       13 |
| denoise            | 0.724 | 0.957 |   105 |     22 |      19 |            0 |        0 |        4 |
| trim               | 0.199 | 0.368 |   110 |     55 |       4 |            1 |        0 |       15 |
| box-0.35           | 0.202 | 0.376 |   111 |     56 |       4 |            1 |        0 |       15 |
| box-0.55           | 0.202 | 0.375 |   111 |     56 |       4 |            1 |        0 |       15 |
| unclip-1.8         | 0.361 | 0.578 |   102 |     54 |       5 |            2 |        0 |       28 |
