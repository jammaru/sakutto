# scan.pdf page 1 real-OCR overlay

Ground truth: `bench/pdf/scan-p1.gt.txt` (reading-ordered transcription of the scan raster).
CER/WER are scored on content-aligned lines (recognition accuracy); `line order` scores
the product output order separately. `coverage` is word-level LCS against the GT.

| approach           | pairing            |   CER |   WER | line order | coverage | cross-column | ms/page | model bytes | lines | blocks | skipped |
| ------------------ | ------------------ | ----: | ----: | ---------: | -------: | -----------: | ------: | ----------: | ----: | -----: | ------: |
| baseline-1x        | tiny_det+small_rec | 0.680 | 0.946 |      0.128 |    0.106 |            1 |   31747 |    22939968 |    99 |     46 |      12 |
| dpi200             | tiny_det+small_rec | 0.202 | 0.376 |      0.512 |    0.697 |            1 |   40161 |    22939968 |   111 |     60 |       5 |
| shipped-baseline   | tiny_det+small_rec | 0.116 | 0.168 |      0.456 |    0.885 |            9 |   32556 |    22939968 |   105 |     60 |       7 |
| default-1600       | tiny_det+small_rec | 0.030 | 0.055 |      0.598 |    0.963 |            0 |   45401 |    22939968 |   117 |     52 |       7 |
| dpi300             | tiny_det+small_rec | 0.030 | 0.055 |      0.586 |    0.964 |            0 |   50410 |    22939968 |   116 |     53 |       3 |
| sauvola            | tiny_det+small_rec | 0.826 | 0.972 |      0.012 |    0.030 |            7 |   27277 |    22939968 |    94 |     33 |      22 |
| dpi200+sauvola     | tiny_det+small_rec | 0.694 | 0.941 |      0.116 |    0.071 |            3 |   38406 |    22939968 |   100 |     44 |      14 |
| dpi200+gray        | tiny_det+small_rec | 0.223 | 0.406 |      0.500 |    0.677 |            7 |   39847 |    22939968 |   110 |     55 |       5 |
| gray+contrast      | tiny_det+small_rec | 0.212 | 0.369 |      0.500 |    0.708 |            9 |   41678 |    22939968 |   112 |     58 |       9 |
| gray+contrast-1600 | tiny_det+small_rec | 0.030 | 0.054 |      0.598 |    0.964 |            0 |   50812 |    22939968 |   117 |     60 |       4 |
| contrast           | tiny_det+small_rec | 0.208 | 0.360 |      0.500 |    0.713 |            9 |   46291 |    22939968 |   112 |     58 |       9 |
| otsu               | tiny_det+small_rec | 0.700 | 0.941 |      0.079 |    0.074 |            6 |   43119 |    22939968 |   100 |     44 |      17 |
| denoise            | tiny_det+small_rec | 0.727 | 0.958 |      0.037 |    0.058 |            1 |   41324 |    22939968 |   100 |     27 |      22 |
| trim               | tiny_det+small_rec | 0.199 | 0.368 |      0.500 |    0.704 |            1 |   39890 |    22939968 |   110 |     59 |       5 |
| box-0.35           | tiny_det+small_rec | 0.202 | 0.376 |      0.512 |    0.697 |            1 |   39564 |    22939968 |   111 |     60 |       5 |
| box-0.55           | tiny_det+small_rec | 0.202 | 0.375 |      0.512 |    0.697 |            1 |   38510 |    22939968 |   111 |     59 |       6 |
| unclip-1.8         | tiny_det+small_rec | 0.361 | 0.578 |      0.407 |    0.559 |            2 |   32084 |    22939968 |   102 |     56 |       7 |
