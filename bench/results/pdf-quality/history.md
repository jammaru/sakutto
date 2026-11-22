| label    | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| -------- | ----: | ------------: | -----------------: | -------------: | -------------: | ----------: | -----------: | ------------: | -------------: | ------: |
| baseline |     5 |             — |     13.0% (旧指標) |          20.9% |          0.84% |       0.000 |        0.062 |         98.3% |            307 |     909 |
| final    |     5 |             — |      0.0% (旧指標) |          10.8% |          0.28% |       0.000 |        0.046 |         98.3% |            261 |     823 |

Rows without a skipped-prose column were recorded before that metric existed (the baseline was
re-scored in baseline.json / baseline.md with the current definition: 13.8%).

iter1 / iter2 runs are kept as separate JSON/MD files; the garbledToken metric was refined once
after iter2 to also count a whole English clause left inside a translated block, and baseline and
final above use that final definition.

Later runs of the same label are numbered below. The current row is the committed `final.json`,
regenerated after the simulated-scan word boxes and raw-source garbling metric were corrected.

| label           | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| --------------- | ----: | ------------: | -----------------: | -------------: | -------------: | ----------: | -----------: | ------------: | -------------: | ------: |
| ocr-iter        |     5 |             — |               0.0% |           4.3% |          0.24% |       0.000 |        0.175 |         89.6% |            295 |     896 |
| ocr-iter2       |     5 |             — |               0.0% |          10.8% |          0.28% |       0.000 |        0.046 |         98.3% |            244 |     794 |
| final (r1)      |     5 |             — |               0.0% |          10.8% |          0.28% |       0.000 |        0.046 |         98.3% |            261 |     823 |
| final (r2)      |     5 |             — |               0.0% |          10.8% |          0.28% |       0.000 |        0.046 |         98.3% |            245 |     791 |
| final (r3)      |     5 |             — |               0.0% |           6.7% |          0.24% |       0.000 |        0.066 |         97.9% |            274 |     859 |
| final (r4)      |     5 |             2 |               1.9% |           6.7% |          0.24% |       0.000 |        0.066 |         97.9% |            316 |     930 |
| final (current) |     5 |             1 |               1.3% |           8.8% |          0.25% |       0.000 |        0.082 |         96.5% |            284 |     866 |

Iteration 6: fair scan GT, content-aligned real-OCR CER, honest mixed-language/garbling
metrics and the band-aware reading-order GT. Draft rows were removed from this history.

| label      | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| ---------- | ----: | ------------: | -----------------: | -------------: | -------------: | ----------: | -----------: | ------------: | -------------: | ------: |
| final (v6) |     5 |             0 |               1.2% |           0.0% |          0.04% |       0.000 |        0.000 |         98.3% |            248 |     779 |
| label      | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| ---        |  ---: |          ---: |               ---: |           ---: |           ---: |        ---: |         ---: |          ---: |           ---: |
| final      |     5 |             0 |               1.2% |           0.0% |          0.04% |       0.000 |        0.000 |         97.6% |            360 |    1035 |
| final      |     5 |             0 |               1.2% |           0.0% |          0.04% |       0.000 |        0.000 |         98.3% |            278 |     889 |
| final      |     5 |             0 |               1.2% |           0.0% |          0.04% |       0.000 |        0.000 |         98.3% |            334 |    1073 |
| label      | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| ---        |  ---: |          ---: |               ---: |           ---: |           ---: |        ---: |         ---: |          ---: |           ---: |
| final      |     5 |             1 |               1.3% |           0.0% |          0.04% |       0.000 |        0.099 |         98.3% |            342 |    1029 |
