# scan.pdf page 1 real-OCR overlay

Ground truth: `bench/pdf/scan-p1.gt.txt` (reading-ordered transcription of the scan raster).
CER/WER are scored on content-aligned lines (recognition accuracy); `line order` scores
the product output order separately. `coverage` is word-level LCS against the GT.

| approach           | pairing            |   CER |   WER | line order | coverage | cross-column | ms/page | model bytes | lines | blocks | skipped |
| ------------------ | ------------------ | ----: | ----: | ---------: | -------: | -----------: | ------: | ----------: | ----: | -----: | ------: |
| baseline-1x        | tiny_det+small_rec | 0.683 | 0.944 |      0.128 |    0.108 |            1 |   24451 |    22939968 |    99 |     55 |       7 |
| dpi200             | tiny_det+small_rec | 0.202 | 0.376 |      0.512 |    0.697 |            1 |   32348 |    22939968 |   111 |     62 |       4 |
| shipped-baseline   | tiny_det+small_rec | 0.116 | 0.168 |      0.456 |    0.885 |            1 |   29335 |    22939968 |   105 |     62 |       7 |
| default-1600       | tiny_det+small_rec | 0.030 | 0.055 |      0.598 |    0.963 |            0 |   38599 |    22939968 |   117 |     53 |       7 |
| dpi300             | tiny_det+small_rec | 0.030 | 0.055 |      0.586 |    0.964 |            0 |   38660 |    22939968 |   116 |     54 |       3 |
| sauvola            | tiny_det+small_rec | 0.826 | 0.971 |      0.012 |    0.030 |            4 |   23717 |    22939968 |    94 |     45 |      21 |
| dpi200+sauvola     | tiny_det+small_rec | 0.702 | 0.944 |      0.116 |    0.071 |            5 |   30665 |    22939968 |   100 |     54 |      14 |
| dpi200+gray        | tiny_det+small_rec | 0.223 | 0.406 |      0.493 |    0.677 |            1 |   32219 |    22939968 |   110 |     57 |       5 |
| gray+contrast      | tiny_det+small_rec | 0.212 | 0.369 |      0.493 |    0.708 |            1 |   32763 |    22939968 |   111 |     58 |       8 |
| gray+contrast-1600 | tiny_det+small_rec | 0.030 | 0.054 |      0.598 |    0.964 |            0 |   36321 |    22939968 |   117 |     61 |       4 |
| contrast           | tiny_det+small_rec | 0.208 | 0.360 |      0.493 |    0.713 |            1 |   35101 |    22939968 |   111 |     58 |       8 |
| otsu               | tiny_det+small_rec | 0.703 | 0.942 |      0.079 |    0.072 |            4 |   34315 |    22939968 |   100 |     51 |      18 |
| denoise            | tiny_det+small_rec | 0.726 | 0.958 |      0.036 |    0.057 |            3 |   31196 |    22939968 |    98 |     41 |      24 |
| trim               | tiny_det+small_rec | 0.199 | 0.368 |      0.500 |    0.704 |            1 |   31991 |    22939968 |   110 |     65 |       4 |
| box-0.35           | tiny_det+small_rec | 0.202 | 0.376 |      0.512 |    0.697 |            1 |   36392 |    22939968 |   111 |     62 |       4 |
| box-0.55           | tiny_det+small_rec | 0.202 | 0.375 |      0.512 |    0.697 |            1 |   37333 |    22939968 |   111 |     61 |       5 |
| unclip-1.8         | tiny_det+small_rec | 0.361 | 0.578 |      0.401 |    0.559 |            2 |   31299 |    22939968 |   102 |     61 |       5 |
