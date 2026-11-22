| label | pages | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| final | 5 | 0.0% | 10.8% | 0.28% | 0.000 | 0.046 | 98.3% | 245 | 791 |

## Text source split

The scan fixture above is SIMULATED OCR: scan.pdf supplies the page size and background, but word boxes are synthesized from paper.pdf text. It measures OCR layout and placement, not recognition. Real recognition on scan.pdf is measured separately with pnpm bench:pdf:scan:ocr and listed below; never read the simulated scan row as a real-scan result.

| text source | pages | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| native (paper, arxiv) | 4 | 0.0% | 7.0% | 0.35% | 0.000 | 0.000 |
| simulated OCR (scan) | 1 | 0.0% | 16.7% | 0.12% | 0.000 | 0.132 |

## Real OCR on scan.pdf page 1 (pnpm bench:pdf:scan:ocr)

| variant | CER | WER | lines | blocks | skipped | cross-column | overlaps | overflow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 0.912 | 1.783 | 58 | 35 | 10 | 0 | 0 | 0 |
| dpi200 | 1.389 | 1.725 | 69 | 52 | 4 | 2 | 0 | 0 |
| default-1600 | 1.411 | 1.627 | 72 | 55 | 6 | 0 | 0 | 0 |
| dpi300 | 1.412 | 1.628 | 72 | 54 | 5 | 0 | 0 | 0 |
| sauvola | 0.725 | 0.963 | 65 | 36 | 30 | 3 | 0 | 0 |
| dpi200+sauvola | 0.792 | 1.368 | 66 | 36 | 13 | 2 | 0 | 0 |
| dpi200+gray | 1.400 | 1.742 | 66 | 46 | 5 | 2 | 0 | 0 |
