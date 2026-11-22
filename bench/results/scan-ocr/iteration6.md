# scan.pdf page 1 real-OCR overlay

Ground truth: `bench/pdf/scan-p1.gt.txt` (reading-ordered transcription of the scan raster).
CER/WER are scored on content-aligned lines (recognition accuracy); `line order` scores
the product output order separately. `coverage` is word-level LCS against the GT.

| approach           | pairing            |   CER |   WER | line order | coverage | cross-column | ms/page | model bytes | lines | blocks | skipped |
| ------------------ | ------------------ | ----: | ----: | ---------: | -------: | -----------: | ------: | ----------: | ----: | -----: | ------: |
| baseline-1x        | tiny_det+small_rec | 0.685 | 0.943 |      0.122 |    0.109 |            2 |   23731 |    22939968 |    97 |     54 |       8 |
| dpi200             | tiny_det+small_rec | 0.210 | 0.380 |      0.506 |    0.696 |            1 |   30018 |    22939968 |   111 |     62 |       4 |
| shipped-baseline   | tiny_det+small_rec | 0.116 | 0.168 |      0.450 |    0.885 |            1 |   26661 |    22939968 |   105 |     62 |       7 |
| default-1600       | tiny_det+small_rec | 0.030 | 0.055 |      0.592 |    0.963 |            0 |   33886 |    22939968 |   117 |     53 |       7 |
| dpi300             | tiny_det+small_rec | 0.030 | 0.055 |      0.580 |    0.964 |            0 |   35112 |    22939968 |   116 |     54 |       3 |
| sauvola            | tiny_det+small_rec | 0.825 | 0.972 |      0.012 |    0.030 |            5 |   20670 |    22939968 |    94 |     44 |      23 |
| dpi200+sauvola     | tiny_det+small_rec | 0.702 | 0.948 |      0.116 |    0.071 |            3 |   27578 |    22939968 |    98 |     56 |      14 |
| dpi200+gray        | tiny_det+small_rec | 0.217 | 0.404 |      0.487 |    0.677 |            1 |   30112 |    22939968 |   110 |     57 |       5 |
| gray+contrast      | tiny_det+small_rec | 0.212 | 0.368 |      0.487 |    0.708 |            1 |   29957 |    22939968 |   111 |     58 |       8 |
| gray+contrast-1600 | tiny_det+small_rec | 0.030 | 0.054 |      0.592 |    0.964 |            0 |   33621 |    22939968 |   117 |     61 |       4 |
| contrast           | tiny_det+small_rec | 0.209 | 0.359 |      0.487 |    0.713 |            1 |   29722 |    22939968 |   111 |     58 |       8 |
| otsu               | tiny_det+small_rec | 0.710 | 0.948 |      0.079 |    0.074 |            3 |   26744 |    22939968 |    98 |     54 |      18 |
| denoise            | tiny_det+small_rec | 0.726 | 0.958 |      0.036 |    0.057 |            4 |   27164 |    22939968 |    97 |     42 |      22 |
| trim               | tiny_det+small_rec | 0.200 | 0.368 |      0.493 |    0.704 |            1 |   29087 |    22939968 |   110 |     65 |       4 |
| box-0.35           | tiny_det+small_rec | 0.210 | 0.380 |      0.506 |    0.696 |            1 |   29388 |    22939968 |   111 |     62 |       4 |
| box-0.55           | tiny_det+small_rec | 0.210 | 0.380 |      0.506 |    0.696 |            1 |   29247 |    22939968 |   111 |     61 |       5 |
| unclip-1.8         | tiny_det+small_rec | 0.360 | 0.578 |      0.395 |    0.559 |            2 |   25285 |    22939968 |   102 |     61 |       5 |
