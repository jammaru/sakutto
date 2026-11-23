# scan.pdf page 1 real-OCR overlay

Ground truth: `bench/pdf/scan-p1.gt.txt` (reading-ordered transcription of the scan raster).
CER/WER are scored on content-aligned lines (recognition accuracy); `line order` scores
the product output order separately. `coverage` is word-level LCS against the GT.

| approach           | pairing            |   CER |   WER | line order | coverage | cross-column | ms/page | model bytes | lines | blocks | skipped | overflow |
| ------------------ | ------------------ | ----: | ----: | ---------: | -------: | -----------: | ------: | ----------: | ----: | -----: | ------: | -------: |
| baseline-1x        | tiny_det+small_rec | 0.682 | 0.947 |      0.141 |    0.106 |            1 |   26030 |    22939968 |   100 |     45 |       9 |       19 |
| dpi200             | tiny_det+small_rec | 0.202 | 0.376 |      0.512 |    0.697 |            1 |   31131 |    22939968 |   111 |     59 |       4 |       18 |
| shipped-baseline   | tiny_det+small_rec | 0.116 | 0.168 |      0.456 |    0.885 |            1 |   29718 |    22939968 |   105 |     59 |       7 |       24 |
| default-1600       | tiny_det+small_rec | 0.030 | 0.055 |      0.598 |    0.963 |            0 |   35222 |    22939968 |   117 |     50 |       7 |        6 |
| dpi300             | tiny_det+small_rec | 0.030 | 0.055 |      0.586 |    0.964 |            0 |   36819 |    22939968 |   116 |     51 |       3 |        3 |
| sauvola            | tiny_det+small_rec | 0.825 | 0.972 |      0.012 |    0.030 |            4 |   21956 |    22939968 |    97 |     34 |      21 |       14 |
| dpi200+sauvola     | tiny_det+small_rec | 0.692 | 0.939 |      0.123 |    0.071 |            2 |   30394 |    22939968 |   105 |     61 |       6 |       29 |
| dpi200+gray        | tiny_det+small_rec | 0.223 | 0.406 |      0.500 |    0.677 |            1 |   32939 |    22939968 |   110 |     53 |       5 |       14 |
| gray+contrast      | tiny_det+small_rec | 0.212 | 0.369 |      0.500 |    0.708 |            1 |   31672 |    22939968 |   112 |     56 |       9 |       15 |
| gray+contrast-1600 | tiny_det+small_rec | 0.030 | 0.054 |      0.598 |    0.964 |            0 |   36854 |    22939968 |   117 |     58 |       4 |        6 |
| contrast           | tiny_det+small_rec | 0.208 | 0.360 |      0.500 |    0.713 |            1 |   32636 |    22939968 |   112 |     56 |       9 |       16 |
| otsu               | tiny_det+small_rec | 0.704 | 0.945 |      0.085 |    0.072 |            2 |   28460 |    22939968 |   104 |     43 |      16 |       16 |
| denoise            | tiny_det+small_rec | 0.724 | 0.956 |      0.037 |    0.059 |            0 |   29410 |    22939968 |   105 |     22 |      20 |        4 |
| trim               | tiny_det+small_rec | 0.199 | 0.368 |      0.500 |    0.704 |            1 |   31051 |    22939968 |   110 |     58 |       4 |       18 |
| box-0.35           | tiny_det+small_rec | 0.202 | 0.376 |      0.512 |    0.697 |            1 |   30554 |    22939968 |   111 |     59 |       4 |       18 |
| box-0.55           | tiny_det+small_rec | 0.202 | 0.375 |      0.512 |    0.697 |            1 |   30758 |    22939968 |   111 |     58 |       5 |       17 |
| unclip-1.8         | tiny_det+small_rec | 0.361 | 0.578 |      0.388 |    0.559 |            1 |   27355 |    22939968 |   102 |     52 |       5 |       28 |
