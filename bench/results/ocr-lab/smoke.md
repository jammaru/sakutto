# OCR experiment lab — smoke

Pairing: tiny_det+small_rec. en-scan, two-column.

| approach | CER | WER | line order | column order | block IoU | ms/page | notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| baseline | 0.00% | 0.0% | 100.0% | 100.0% | 0.66 | 1456 | baseline |
| dpi200 | 0.00% | 0.0% | 100.0% | 100.0% | 0.68 | 1700 | render |
| gray+contrast | 0.00% | 0.0% | 100.0% | 100.0% | 0.68 | 1378 | preprocess grayscale+contrast |
| otsu | 0.00% | 0.0% | 100.0% | 100.0% | 0.61 | 1372 | preprocess otsu |
