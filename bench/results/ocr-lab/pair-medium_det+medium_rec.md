# OCR experiment lab — pair-medium_det_medium_rec

Pairing: medium_det+medium_rec. en-scan, ja-horizontal, ja-vertical, slides, low-res-skew, two-column, mixed-ja-en, small-text.
One unreported warm-up inference is run before timing; ms/page excludes it.

| approach  |   CER |  WER | line order | column order | block IoU | ms/page | notes                       |
| --------- | ----: | ---: | ---------: | -----------: | --------: | ------: | --------------------------- |
| baseline  | 0.43% | 5.5% |     100.0% |       100.0% |      0.75 |    8287 | baseline                    |
| sauvola   | 0.41% | 4.2% |     100.0% |       100.0% |      0.80 |    7804 | preprocess sauvola          |
| otsu+trim | 0.22% | 2.3% |     100.0% |       100.0% |      0.84 |    5506 | preprocess otsu+trim-border |
