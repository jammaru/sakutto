# OCR experiment lab — pair-tiny_det+medium_rec

Pairing: tiny_det+medium_rec. en-scan, two-column, mixed-ja-en, small-text.

| approach  |   CER |   WER | line order | column order | block IoU | ms/page | notes                       |
| --------- | ----: | ----: | ---------: | -----------: | --------: | ------: | --------------------------- |
| baseline  | 0.86% | 10.9% |     100.0% |       100.0% |      0.74 |    4547 | baseline                    |
| sauvola   | 0.65% |  7.8% |     100.0% |       100.0% |      0.72 |    4536 | preprocess sauvola          |
| otsu+trim | 0.43% |  4.7% |     100.0% |       100.0% |      0.87 |    4327 | preprocess otsu+trim-border |
