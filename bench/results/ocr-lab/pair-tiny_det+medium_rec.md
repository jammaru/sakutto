# OCR experiment lab — pair-tiny_det_medium_rec

Pairing: tiny_det+medium_rec. en-scan, ja-horizontal, ja-vertical, slides, low-res-skew, two-column, mixed-ja-en, small-text.
One unreported warm-up inference is run before timing; ms/page excludes it.

| approach  |   CER |  WER | line order | column order | block IoU | ms/page | notes                       |
| --------- | ----: | ---: | ---------: | -----------: | --------: | ------: | --------------------------- |
| baseline  | 0.43% | 5.5% |     100.0% |       100.0% |      0.77 |    4145 | baseline                    |
| sauvola   | 0.52% | 5.8% |     100.0% |       100.0% |      0.77 |    4112 | preprocess sauvola          |
| otsu+trim | 0.22% | 2.3% |     100.0% |       100.0% |      0.83 |    3972 | preprocess otsu+trim-border |
