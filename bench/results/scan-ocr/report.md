# scan.pdf page 1 real-OCR overlay

Ground truth: `bench/pdf/scan-p1.gt.txt` (reading-ordered transcription of the scan raster).
CER/WER are scored on content-aligned lines (recognition accuracy); `line order` scores
the product output order separately. `coverage` is word-level LCS against the GT.

| approach           | pairing            |   CER |   WER | line order | coverage | cross-column | ms/page | model bytes | lines | blocks | skipped | overflow |
| ------------------ | ------------------ | ----: | ----: | ---------: | -------: | -----------: | ------: | ----------: | ----: | -----: | ------: | -------: |
| baseline-1x        | tiny_det+small_rec | 0.667 | 0.948 |      0.154 |    0.110 |            1 |   24491 |    22939968 |   100 |     43 |       9 |       18 |
| dpi200             | tiny_det+small_rec | 0.205 | 0.376 |      0.525 |    0.697 |            1 |   33373 |    22939968 |   110 |     57 |       4 |       17 |
| shipped-baseline   | tiny_det+small_rec | 0.116 | 0.168 |      0.488 |    0.885 |            2 |   29147 |    22939968 |   105 |     57 |       7 |       22 |
| default-1600       | tiny_det+small_rec | 0.054 | 0.077 |      0.611 |    0.952 |            1 |   37123 |    22939968 |   116 |     49 |       7 |        5 |
| dpi300             | tiny_det+small_rec | 0.054 | 0.076 |      0.592 |    0.953 |            0 |   39162 |    22939968 |   115 |     50 |       3 |        6 |
| sauvola            | tiny_det+small_rec | 0.825 | 0.972 |      0.012 |    0.030 |            2 |   26310 |    22939968 |    97 |     34 |      15 |       15 |
| dpi200+sauvola     | tiny_det+small_rec | 0.686 | 0.937 |      0.123 |    0.072 |            1 |   31563 |    22939968 |   103 |     61 |       6 |       28 |
| dpi200+gray        | tiny_det+small_rec | 0.245 | 0.425 |      0.506 |    0.669 |            1 |   33254 |    22939968 |   109 |     51 |       4 |       15 |
| gray+contrast      | tiny_det+small_rec | 0.230 | 0.386 |      0.506 |    0.700 |            1 |   33282 |    22939968 |   111 |     53 |       8 |       15 |
| gray+contrast-1600 | tiny_det+small_rec | 0.054 | 0.075 |      0.611 |    0.953 |            1 |   37721 |    22939968 |   116 |     57 |       4 |        7 |
| contrast           | tiny_det+small_rec | 0.227 | 0.379 |      0.506 |    0.704 |            1 |   31274 |    22939968 |   111 |     53 |       8 |       15 |
| otsu               | tiny_det+small_rec | 0.689 | 0.941 |      0.098 |    0.075 |            1 |   32649 |    22939968 |   104 |     39 |      14 |       13 |
| denoise            | tiny_det+small_rec | 0.724 | 0.957 |      0.037 |    0.059 |            0 |   30422 |    22939968 |   104 |     22 |      19 |        5 |
| trim               | tiny_det+small_rec | 0.223 | 0.386 |      0.494 |    0.698 |            1 |   32375 |    22939968 |   108 |     57 |       5 |       19 |
| box-0.35           | tiny_det+small_rec | 0.205 | 0.376 |      0.525 |    0.697 |            1 |   32875 |    22939968 |   110 |     57 |       4 |       17 |
| box-0.55           | tiny_det+small_rec | 0.205 | 0.375 |      0.525 |    0.697 |            1 |   34009 |    22939968 |   110 |     57 |       4 |       17 |
| unclip-1.8         | tiny_det+small_rec | 0.361 | 0.578 |      0.426 |    0.559 |            2 |   28527 |    22939968 |   102 |     54 |       5 |       28 |
