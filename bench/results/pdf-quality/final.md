| label | pages | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| final | 5 | 0.0% | 6.7% | 0.24% | 0.000 | 0.066 | 97.9% | 274 | 859 |

## Text source split

The scan fixture above is SIMULATED OCR: scan.pdf supplies the page size and background, but word boxes are synthesized from paper.pdf text. It measures OCR layout and placement, not recognition. Real recognition on scan.pdf is measured separately with pnpm bench:pdf:scan:ocr and listed below; never read the simulated scan row as a real-scan result.

| text source | pages | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| native (paper, arxiv) | 4 | 0.0% | 7.0% | 0.35% | 0.000 | 0.000 |
| simulated OCR (scan) | 1 | 0.0% | 6.3% | 0.00% | 0.000 | 0.160 |

## Real OCR on scan.pdf page 1 (pnpm bench:pdf:scan:ocr)

| variant | CER | WER | lines | blocks | skipped | cross-column | overlaps | overflow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline-1x | 0.912 | 1.783 | 58 | 47 | 10 | 5 | 0 | 0 |
| dpi200 | 1.389 | 1.725 | 69 | 61 | 3 | 9 | 0 | 0 |
| shipped-baseline | 1.461 | 1.693 | 61 | 50 | 9 | 8 | 0 | 0 |
| default-1600 | 1.411 | 1.627 | 72 | 61 | 5 | 8 | 0 | 0 |
| dpi300 | 1.412 | 1.628 | 72 | 61 | 4 | 8 | 0 | 0 |
| sauvola | 0.725 | 0.963 | 65 | 36 | 30 | 5 | 0 | 0 |
| dpi200+sauvola | 0.792 | 1.368 | 66 | 42 | 14 | 8 | 0 | 0 |
| dpi200+gray | 1.400 | 1.742 | 66 | 55 | 5 | 11 | 0 | 0 |
