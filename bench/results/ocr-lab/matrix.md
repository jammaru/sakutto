# OCR experiment lab — matrix

Pairing: tiny_det+small_rec. en-scan, ja-horizontal, ja-vertical, slides, low-res-skew, two-column, mixed-ja-en, small-text.
One unreported warm-up inference is run before timing; ms/page excludes it.

| approach             |   CER |   WER | line order | column order | block IoU | ms/page | notes                                |
| -------------------- | ----: | ----: | ---------: | -----------: | --------: | ------: | ------------------------------------ |
| baseline             | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1184 | baseline                             |
| dpi150               | 0.43% |  5.5% |     100.0% |       100.0% |      0.78 |     996 | render                               |
| dpi200               | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1397 | render                               |
| dpi300               | 0.78% |  9.5% |     100.0% |       100.0% |      0.80 |    2087 | render                               |
| gray                 | 0.54% |  7.0% |     100.0% |       100.0% |      0.77 |    1173 | preprocess grayscale                 |
| contrast             | 0.43% |  5.5% |     100.0% |        93.8% |      0.76 |    1176 | preprocess contrast                  |
| gray+contrast        | 0.43% |  5.5% |     100.0% |        93.8% |      0.76 |    1175 | preprocess grayscale+contrast        |
| otsu                 | 0.32% |  4.7% |     100.0% |       100.0% |      0.75 |    1184 | preprocess otsu                      |
| sauvola              | 0.31% |  3.4% |     100.0% |       100.0% |      0.77 |    1202 | preprocess sauvola                   |
| denoise              | 0.72% |  8.6% |     100.0% |       100.0% |      0.76 |    1164 | preprocess denoise                   |
| deskew               | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1175 | preprocess deskew                    |
| trim                 | 0.86% |  9.4% |     100.0% |       100.0% |      0.76 |    1053 | preprocess trim-border               |
| gray+contrast+deskew | 0.43% |  5.5% |     100.0% |        93.8% |      0.76 |    1196 | preprocess grayscale+contrast+deskew |
| otsu+trim            | 0.43% |  5.5% |     100.0% |       100.0% |      0.83 |    1000 | preprocess otsu+trim-border          |
| sauvola+trim         | 0.47% |  5.4% |     100.0% |       100.0% |      0.77 |    1028 | preprocess sauvola+trim-border       |
| det-threshold-0.3    | 0.75% |  7.8% |     100.0% |       100.0% |      0.75 |    1190 | detection                            |
| det-threshold-0.1    | 0.75% |  7.8% |     100.0% |       100.0% |      0.77 |    1226 | detection                            |
| box-0.35             | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1209 | detection                            |
| box-0.55             | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1255 | detection                            |
| unclip-1.1           | 0.54% |  7.0% |     100.0% |       100.0% |      0.68 |    1381 | detection                            |
| unclip-1.8           | 0.75% |  7.8% |     100.0% |       100.0% |      0.86 |    1089 | detection                            |
| tiling-512-64        | 9.06% | 33.8% |      95.8% |        61.0% |      0.61 |    1421 | tiling                               |
| rerun-0.5            | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1171 | confidence                           |
| rerun-0.7            | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1229 | confidence                           |
| adaptive-14          | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1195 | adaptive                             |
| adaptive-18          | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1242 | adaptive                             |
| best-combo           | 0.78% |  8.8% |     100.0% |       100.0% |      0.77 |    1448 | combined grayscale+contrast          |
