# OCR experiment lab — matrix

Pairing: tiny_det+small_rec. en-scan, ja-horizontal, ja-vertical, slides, low-res-skew, two-column, mixed-ja-en, small-text.

| approach             |   CER |   WER | line order | column order | block IoU | ms/page | notes                                |
| -------------------- | ----: | ----: | ---------: | -----------: | --------: | ------: | ------------------------------------ |
| baseline             | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1221 | baseline                             |
| dpi150               | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1143 | render                               |
| dpi200               | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1375 | render                               |
| dpi300               | 0.78% |  9.5% |     100.0% |       100.0% |      0.80 |    2144 | render                               |
| gray                 | 0.54% |  7.0% |     100.0% |       100.0% |      0.77 |    1239 | preprocess grayscale                 |
| contrast             | 0.43% |  5.5% |     100.0% |        93.8% |      0.76 |    1170 | preprocess contrast                  |
| gray+contrast        | 0.43% |  5.5% |     100.0% |        93.8% |      0.76 |    1210 | preprocess grayscale+contrast        |
| otsu                 | 0.32% |  4.7% |     100.0% |       100.0% |      0.75 |    1143 | preprocess otsu                      |
| sauvola              | 0.31% |  3.4% |     100.0% |       100.0% |      0.77 |    1190 | preprocess sauvola                   |
| denoise              | 0.72% |  8.6% |     100.0% |       100.0% |      0.76 |    1117 | preprocess denoise                   |
| deskew               | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1129 | preprocess deskew                    |
| trim                 | 0.86% |  9.4% |     100.0% |       100.0% |      0.76 |     985 | preprocess trim-border               |
| gray+contrast+deskew | 0.43% |  5.5% |     100.0% |        93.8% |      0.76 |    1102 | preprocess grayscale+contrast+deskew |
| otsu+trim            | 0.43% |  5.5% |     100.0% |       100.0% |      0.83 |     966 | preprocess otsu+trim-border          |
| sauvola+trim         | 0.47% |  5.4% |     100.0% |       100.0% |      0.77 |    1004 | preprocess sauvola+trim-border       |
| det-threshold-0.3    | 0.75% |  7.8% |     100.0% |       100.0% |      0.75 |    1187 | detection                            |
| det-threshold-0.1    | 0.75% |  7.8% |     100.0% |       100.0% |      0.77 |    1101 | detection                            |
| box-0.35             | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1127 | detection                            |
| box-0.55             | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1107 | detection                            |
| unclip-1.1           | 0.54% |  7.0% |     100.0% |       100.0% |      0.68 |    1211 | detection                            |
| unclip-1.8           | 0.75% |  7.8% |     100.0% |       100.0% |      0.86 |    1004 | detection                            |
| tiling-512-64        | 9.06% | 33.8% |     100.0% |        61.0% |      0.61 |    1314 | tiling                               |
| rerun-0.5            | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1109 | confidence                           |
| rerun-0.7            | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1114 | confidence                           |
| adaptive-14          | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1103 | adaptive                             |
| adaptive-18          | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1103 | adaptive                             |
| best-combo           | 0.78% |  8.8% |     100.0% |       100.0% |      0.77 |    1320 | combined grayscale+contrast          |
