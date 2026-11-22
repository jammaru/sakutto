# OCR experiment lab — pair-standard

Pairing: tiny_det+small_rec. en-scan, two-column, mixed-ja-en, small-text.

| approach | CER | WER | line order | column order | block IoU | ms/page | notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| baseline | 1.72% | 18.8% | 100.0% | 100.0% | 0.74 | 1269 | baseline |
| sauvola | 0.22% | 3.1% | 100.0% | 100.0% | 0.72 | 1239 | preprocess sauvola |
| otsu+trim | 0.86% | 10.9% | 100.0% | 100.0% | 0.87 | 1068 | preprocess otsu+trim-border |
