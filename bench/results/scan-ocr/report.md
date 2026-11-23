# scan.pdf page 1 real-OCR overlay

Ground truth: `bench/pdf/scan-p1.gt.txt` (reading-ordered transcription of the scan raster).
CER/WER are scored on content-aligned lines (recognition accuracy); `line order` scores
the product output order separately. `coverage` is word-level LCS against the GT.

| approach           | pairing            |   CER |   WER | line order | coverage | cross-column | ms/page | model bytes | lines | blocks | skipped | overflow |
| ------------------ | ------------------ | ----: | ----: | ---------: | -------: | -----------: | ------: | ----------: | ----: | -----: | ------: | -------: |
| baseline-1x        | tiny_det+small_rec | 0.667 | 0.948 |      0.154 |    0.110 |            0 |   24207 |    22939968 |   100 |     43 |       9 |       18 |
| dpi200             | tiny_det+small_rec | 0.202 | 0.376 |      0.537 |    0.697 |            0 |   30566 |    22939968 |   111 |     56 |       4 |       15 |
| shipped-baseline   | tiny_det+small_rec | 0.116 | 0.168 |      0.488 |    0.885 |            0 |   29087 |    22939968 |   105 |     57 |       7 |       22 |
| default-1600       | tiny_det+small_rec | 0.054 | 0.077 |      0.611 |    0.952 |            0 |   36394 |    22939968 |   116 |     49 |       7 |        5 |
| dpi300             | tiny_det+small_rec | 0.054 | 0.076 |      0.592 |    0.953 |            0 |   37517 |    22939968 |   115 |     50 |       3 |        6 |
| sauvola            | tiny_det+small_rec | 0.825 | 0.972 |      0.012 |    0.030 |            2 |   23077 |    22939968 |    97 |     34 |      15 |       15 |
| dpi200+sauvola     | tiny_det+small_rec | 0.686 | 0.937 |      0.123 |    0.072 |            0 |   29996 |    22939968 |   103 |     61 |       6 |       28 |
| dpi200+gray        | tiny_det+small_rec | 0.245 | 0.425 |      0.506 |    0.669 |            0 |   32267 |    22939968 |   109 |     51 |       4 |       15 |
| gray+contrast      | tiny_det+small_rec | 0.230 | 0.386 |      0.506 |    0.700 |            0 |   30881 |    22939968 |   111 |     53 |       8 |       15 |
| gray+contrast-1600 | tiny_det+small_rec | 0.054 | 0.075 |      0.611 |    0.953 |            0 |   35826 |    22939968 |   116 |     57 |       4 |        7 |
| contrast           | tiny_det+small_rec | 0.227 | 0.379 |      0.506 |    0.704 |            0 |   31206 |    22939968 |   111 |     53 |       8 |       15 |
| otsu               | tiny_det+small_rec | 0.689 | 0.941 |      0.098 |    0.075 |            0 |   28694 |    22939968 |   104 |     39 |      14 |       13 |
| denoise            | tiny_det+small_rec | 0.724 | 0.957 |      0.037 |    0.059 |            0 |   29259 |    22939968 |   104 |     22 |      19 |        5 |
| trim               | tiny_det+small_rec | 0.220 | 0.386 |      0.506 |    0.698 |            0 |   32079 |    22939968 |   109 |     56 |       5 |       17 |
| box-0.35           | tiny_det+small_rec | 0.202 | 0.376 |      0.537 |    0.697 |            0 |   31548 |    22939968 |   111 |     56 |       4 |       15 |
| box-0.55           | tiny_det+small_rec | 0.202 | 0.375 |      0.537 |    0.697 |            0 |   31609 |    22939968 |   111 |     56 |       4 |       15 |
| unclip-1.8         | tiny_det+small_rec | 0.361 | 0.578 |      0.426 |    0.559 |            0 |   26467 |    22939968 |   102 |     54 |       5 |       28 |
