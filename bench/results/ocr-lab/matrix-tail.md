# OCR experiment lab — matrix-tail

Pairing: tiny_det+small_rec. en-scan, ja-horizontal, ja-vertical, slides, low-res-skew, two-column, mixed-ja-en, small-text.

| approach      |   CER |   WER | line order | column order | block IoU | ms/page | notes                       |
| ------------- | ----: | ----: | ---------: | -----------: | --------: | ------: | --------------------------- |
| tiling-512-64 | 9.06% | 33.8% |     100.0% |        95.5% |      0.61 |    1352 | tiling                      |
| rerun-0.5     | 0.86% |  9.4% |     100.0% |        96.9% |      0.77 |    1115 | confidence                  |
| rerun-0.7     | 0.86% |  9.4% |     100.0% |        96.9% |      0.77 |    1129 | confidence                  |
| adaptive-14   | 0.86% |  9.4% |     100.0% |        96.9% |      0.77 |    1118 | adaptive                    |
| adaptive-18   | 0.86% |  9.4% |     100.0% |        96.9% |      0.77 |    1138 | adaptive                    |
| best-combo    | 0.78% |  8.8% |     100.0% |        96.9% |      0.77 |    1332 | combined grayscale+contrast |
