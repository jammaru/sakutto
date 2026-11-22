# OCR experiment lab — pair-small_det+small_rec

Pairing: small_det+small_rec. en-scan, two-column, mixed-ja-en, small-text.

| approach | CER | WER | line order | column order | block IoU | ms/page | notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| baseline | 1.72% | 18.8% | 100.0% | 100.0% | 0.72 | 1795 | baseline |
| sauvola | 0.86% | 10.9% | 100.0% | 100.0% | 0.72 | 1780 | preprocess sauvola |
| otsu+trim | 0.65% | 9.4% | 100.0% | 100.0% | 0.78 | 1202 | preprocess otsu+trim-border |
