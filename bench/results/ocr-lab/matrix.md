# OCR experiment lab — matrix

Pairing: tiny_det+small_rec. en-scan, ja-horizontal, ja-vertical, slides, low-res-skew, two-column, mixed-ja-en, small-text.

| approach | CER | WER | line order | column order | block IoU | ms/page | notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| baseline | 0.86% | 9.4% | 100.0% | 96.9% | 0.77 | 1184 | baseline |
| dpi150 | 0.86% | 9.4% | 100.0% | 96.9% | 0.77 | 1135 | render |
| dpi200 | 0.86% | 9.4% | 100.0% | 96.9% | 0.77 | 1352 | render |
| dpi300 | 0.78% | 9.5% | 100.0% | 96.9% | 0.80 | 1995 | render |
| gray | 0.54% | 7.0% | 100.0% | 96.9% | 0.77 | 1124 | preprocess grayscale |
| contrast | 0.43% | 5.5% | 100.0% | 94.8% | 0.76 | 1116 | preprocess contrast |
| gray+contrast | 0.43% | 5.5% | 100.0% | 94.8% | 0.76 | 1140 | preprocess grayscale+contrast |
| otsu | 0.32% | 4.7% | 100.0% | 96.9% | 0.75 | 1127 | preprocess otsu |
| sauvola | 0.31% | 3.4% | 100.0% | 96.9% | 0.77 | 1105 | preprocess sauvola |
| denoise | 0.72% | 8.6% | 100.0% | 96.9% | 0.76 | 1117 | preprocess denoise |
| deskew | 0.86% | 9.4% | 100.0% | 96.9% | 0.77 | 1095 | preprocess deskew |
| trim | 0.86% | 9.4% | 100.0% | 96.9% | 0.76 | 1033 | preprocess trim-border |
| gray+contrast+deskew | 0.43% | 5.5% | 100.0% | 94.8% | 0.76 | 1159 | preprocess grayscale+contrast+deskew |
| otsu+trim | 0.43% | 5.5% | 100.0% | 96.9% | 0.83 | 948 | preprocess otsu+trim-border |
| sauvola+trim | 0.47% | 5.4% | 100.0% | 96.9% | 0.77 | 980 | preprocess sauvola+trim-border |
| det-threshold-0.3 | 0.75% | 7.8% | 100.0% | 96.9% | 0.75 | 1123 | detection |
| det-threshold-0.1 | 0.75% | 7.8% | 100.0% | 96.9% | 0.77 | 1098 | detection |
| box-0.35 | 0.86% | 9.4% | 100.0% | 96.9% | 0.77 | 1103 | detection |
| box-0.55 | 0.86% | 9.4% | 100.0% | 96.9% | 0.77 | 1103 | detection |
| unclip-1.1 | 0.54% | 7.0% | 100.0% | 96.9% | 0.68 | 1206 | detection |
| unclip-1.8 | 0.75% | 7.8% | 100.0% | 96.9% | 0.86 | 1005 | detection |
| tiling-512-64 | 9.06% | 33.8% | 100.0% | 95.5% | 0.61 | 1302 | tiling |
| rerun-0.5 | 0.86% | 9.4% | 100.0% | 96.9% | 0.77 | 1111 | confidence |
| rerun-0.7 | 0.86% | 9.4% | 100.0% | 96.9% | 0.77 | 1136 | confidence |
| adaptive-14 | 0.86% | 9.4% | 100.0% | 96.9% | 0.77 | 1108 | adaptive |
| adaptive-18 | 0.86% | 9.4% | 100.0% | 96.9% | 0.77 | 1109 | adaptive |
| best-combo | 0.78% | 8.8% | 100.0% | 96.9% | 0.77 | 1317 | combined grayscale+contrast |
