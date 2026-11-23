| label | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| final | 5 | 0 | 0.0% | 0.0% | 0.04% | 0.000 | 0.024 | 98.3% | 313 | 917 |

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
| baseline-1x        | 0.682 | 0.947 |   100 |     45 |       9 |            1 |        0 |       19 |
| dpi200             | 0.202 | 0.376 |   111 |     59 |       4 |            1 |        0 |       18 |
| shipped-baseline   | 0.116 | 0.168 |   105 |     59 |       7 |            1 |        0 |       24 |
| default-1600       | 0.030 | 0.055 |   117 |     50 |       7 |            0 |        0 |        6 |
| dpi300             | 0.030 | 0.055 |   116 |     51 |       3 |            0 |        0 |        3 |
| sauvola            | 0.825 | 0.972 |    97 |     34 |      21 |            4 |        0 |       14 |
| dpi200+sauvola     | 0.692 | 0.939 |   105 |     61 |       6 |            2 |        0 |       29 |
| dpi200+gray        | 0.223 | 0.406 |   110 |     53 |       5 |            1 |        0 |       14 |
| gray+contrast      | 0.212 | 0.369 |   112 |     56 |       9 |            1 |        0 |       15 |
| gray+contrast-1600 | 0.030 | 0.054 |   117 |     58 |       4 |            0 |        0 |        6 |
| contrast           | 0.208 | 0.360 |   112 |     56 |       9 |            1 |        0 |       16 |
| otsu               | 0.704 | 0.945 |   104 |     43 |      16 |            2 |        0 |       16 |
| denoise            | 0.724 | 0.956 |   105 |     22 |      20 |            0 |        0 |        4 |
| trim               | 0.199 | 0.368 |   110 |     58 |       4 |            1 |        0 |       18 |
| box-0.35           | 0.202 | 0.376 |   111 |     59 |       4 |            1 |        0 |       18 |
| box-0.55           | 0.202 | 0.375 |   111 |     58 |       5 |            1 |        0 |       17 |
| unclip-1.8         | 0.361 | 0.578 |   102 |     52 |       5 |            1 |        0 |       28 |
