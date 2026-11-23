# scan.pdf page 1 real-OCR overlay

Ground truth: `bench/pdf/scan-p1.gt.txt` (reading-ordered transcription of the scan raster).
CER/WER are scored on content-aligned lines (recognition accuracy); `line order` scores
the product output order separately. `coverage` is word-level LCS against the GT.

| approach           | pairing               |   CER |   WER | line order | coverage | cross-column | ms/page | model bytes | lines | blocks | skipped | overflow |
| ------------------ | --------------------- | ----: | ----: | ---------: | -------: | -----------: | ------: | ----------: | ----: | -----: | ------: | -------: |
| default-1600       | medium_det+medium_rec | 0.036 | 0.064 |      0.592 |    0.956 |            0 |  213735 |   138587816 |   117 |     57 |       2 |        5 |
| gray+contrast-1600 | medium_det+medium_rec | 0.034 | 0.056 |      0.605 |    0.965 |            0 |  181030 |   138587816 |   118 |     57 |       3 |        3 |
