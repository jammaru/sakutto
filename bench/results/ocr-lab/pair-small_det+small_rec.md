# OCR experiment lab — pair-small_det_small_rec

Pairing: small_det+small_rec. en-scan, ja-horizontal, ja-vertical, slides, low-res-skew, two-column, mixed-ja-en, small-text.
One unreported warm-up inference is run before timing; ms/page excludes it.

| approach  |   CER |   WER | line order | column order | block IoU | ms/page | notes                       |
| --------- | ----: | ----: | ---------: | -----------: | --------: | ------: | --------------------------- |
| baseline  | 3.94% | 13.1% |      95.8% |       100.0% |      0.74 |    1594 | baseline                    |
| sauvola   | 0.63% |  7.3% |     100.0% |       100.0% |      0.77 |    1506 | preprocess sauvola          |
| otsu+trim | 0.56% |  7.2% |     100.0% |       100.0% |      0.78 |    1161 | preprocess otsu+trim-border |
