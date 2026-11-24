# OCR experiment lab — pair-standard

Pairing: tiny_det+small_rec. en-scan, ja-horizontal, ja-vertical, slides, low-res-skew, two-column, mixed-ja-en, small-text.
One unreported warm-up inference is run before timing; ms/page excludes it.

| approach  |   CER |  WER | line order | column order | block IoU | ms/page | notes                       |
| --------- | ----: | ---: | ---------: | -----------: | --------: | ------: | --------------------------- |
| baseline  | 0.86% | 9.4% |     100.0% |       100.0% |      0.77 |    1214 | baseline                    |
| sauvola   | 0.31% | 3.4% |     100.0% |       100.0% |      0.77 |    1164 | preprocess sauvola          |
| otsu+trim | 0.43% | 5.5% |     100.0% |       100.0% |      0.83 |    1013 | preprocess otsu+trim-border |
