# scan.pdf page 1 real-OCR overlay

Ground truth: `bench/pdf/scan-p1.gt.txt` (reading-ordered transcription of the scan raster).
CER/WER are scored on content-aligned lines (recognition accuracy); `line order` scores
the product output order separately. `coverage` is word-level LCS against the GT.

| approach           | pairing               |   CER |   WER | line order | coverage | cross-column | ms/page | model bytes | lines | blocks | skipped |
| ------------------ | --------------------- | ----: | ----: | ---------: | -------: | -----------: | ------: | ----------: | ----: | -----: | ------: |
| default-1600       | medium_det+medium_rec | 0.036 | 0.064 |      0.586 |    0.956 |            0 |  162422 |   138587816 |   117 |     59 |       2 |
| gray+contrast-1600 | medium_det+medium_rec | 0.034 | 0.056 |      0.598 |    0.965 |            0 |  170473 |   138587816 |   118 |     60 |       3 |
