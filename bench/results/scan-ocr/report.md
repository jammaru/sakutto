# scan.pdf page 1 real-OCR overlay

Ground truth: `bench/pdf/scan-p1.gt.txt` (reading-ordered transcription of the scan raster).
CER/WER are scored on content-aligned lines (recognition accuracy); `line order` scores
the product output order separately. `coverage` is word-level LCS against the GT.

| approach           | pairing            |   CER |   WER | line order | coverage | cross-column | ms/page | model bytes | lines | blocks | skipped | overflow |
| ------------------ | ------------------ | ----: | ----: | ---------: | -------: | -----------: | ------: | ----------: | ----: | -----: | ------: | -------: |
| baseline-1x        | tiny_det+small_rec | 0.667 | 0.948 |      0.154 |    0.110 |            1 |   24069 |    22939968 |   100 |     43 |       9 |       18 |
| dpi200             | tiny_det+small_rec | 0.202 | 0.376 |      0.537 |    0.697 |            1 |   32519 |    22939968 |   111 |     56 |       4 |       15 |
| shipped-baseline   | tiny_det+small_rec | 0.116 | 0.168 |      0.488 |    0.885 |            2 |   32604 |    22939968 |   105 |     57 |       7 |       22 |
| default-1600       | tiny_det+small_rec | 0.030 | 0.055 |      0.630 |    0.963 |            0 |   42493 |    22939968 |   117 |     48 |       6 |        4 |
| dpi300             | tiny_det+small_rec | 0.030 | 0.055 |      0.611 |    0.964 |            0 |   41568 |    22939968 |   116 |     49 |       3 |        3 |
| sauvola            | tiny_det+small_rec | 0.825 | 0.972 |      0.012 |    0.031 |            1 |   22535 |    22939968 |    98 |     33 |      17 |       15 |
| dpi200+sauvola     | tiny_det+small_rec | 0.686 | 0.936 |      0.123 |    0.072 |            1 |   30484 |    22939968 |   104 |     60 |       6 |       27 |
| dpi200+gray        | tiny_det+small_rec | 0.223 | 0.405 |      0.525 |    0.677 |            1 |   32097 |    22939968 |   110 |     51 |       4 |       12 |
| gray+contrast      | tiny_det+small_rec | 0.212 | 0.369 |      0.525 |    0.708 |            1 |   32420 |    22939968 |   112 |     53 |       8 |       12 |
| gray+contrast-1600 | tiny_det+small_rec | 0.030 | 0.054 |      0.630 |    0.964 |            0 |   35803 |    22939968 |   117 |     56 |       4 |        4 |
| contrast           | tiny_det+small_rec | 0.208 | 0.360 |      0.525 |    0.713 |            1 |   30518 |    22939968 |   112 |     53 |       8 |       12 |
| otsu               | tiny_det+small_rec | 0.689 | 0.941 |      0.098 |    0.075 |            1 |   27471 |    22939968 |   104 |     38 |      15 |       13 |
| denoise            | tiny_det+small_rec | 0.724 | 0.957 |      0.037 |    0.059 |            0 |   27796 |    22939968 |   105 |     22 |      19 |        4 |
| trim               | tiny_det+small_rec | 0.199 | 0.368 |      0.525 |    0.704 |            1 |   30260 |    22939968 |   110 |     55 |       4 |       15 |
| box-0.35           | tiny_det+small_rec | 0.202 | 0.376 |      0.537 |    0.697 |            1 |   30544 |    22939968 |   111 |     56 |       4 |       15 |
| box-0.55           | tiny_det+small_rec | 0.202 | 0.375 |      0.537 |    0.697 |            1 |   30263 |    22939968 |   111 |     56 |       4 |       15 |
| unclip-1.8         | tiny_det+small_rec | 0.361 | 0.578 |      0.426 |    0.559 |            2 |   26036 |    22939968 |   102 |     54 |       5 |       28 |
