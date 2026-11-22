# OCR experiment lab — pair-medium_det+medium_rec

Pairing: medium_det+medium_rec. en-scan, two-column, mixed-ja-en, small-text.

| approach | CER | WER | line order | column order | block IoU | ms/page | notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| baseline | 0.86% | 10.9% | 100.0% | 100.0% | 0.74 | 8328 | baseline |
| sauvola | 0.43% | 4.7% | 100.0% | 100.0% | 0.79 | 8212 | preprocess sauvola |
| otsu+trim | 0.43% | 4.7% | 100.0% | 100.0% | 0.88 | 5347 | preprocess otsu+trim-border |
