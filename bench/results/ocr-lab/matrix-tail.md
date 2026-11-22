# OCR experiment lab — matrix-tail

Pairing: tiny_det+small_rec. en-scan, ja-horizontal, ja-vertical, slides, low-res-skew, two-column, mixed-ja-en, small-text.

| approach      |   CER |   WER | line order | column order | block IoU | ms/page | notes                       |
| ------------- | ----: | ----: | ---------: | -----------: | --------: | ------: | --------------------------- |
| tiling-512-64 | 9.06% | 33.8% |     100.0% |        61.0% |      0.61 |    1407 | tiling                      |
| rerun-0.5     | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1143 | confidence                  |
| rerun-0.7     | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1116 | confidence                  |
| adaptive-14   | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1130 | adaptive                    |
| adaptive-18   | 0.86% |  9.4% |     100.0% |       100.0% |      0.77 |    1129 | adaptive                    |
| best-combo    | 0.78% |  8.8% |     100.0% |       100.0% |      0.77 |    1340 | combined grayscale+contrast |
