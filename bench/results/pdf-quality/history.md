# PDF quality bench history

Rows without a skipped-prose column predate that metric. The two legacy rows also predate the
current garbling and mixed-language definitions, so they are context only, not a like-for-like
baseline. The `baseline` row below uses the current scoring and matches `baseline.json` /
`baseline.md`.

The `final (pre-review)` and `final (rN)` rows are previous review rounds' committed results.
Each `pnpm bench:pdf:quality --label final` appends a new `final` row to the end of this table;
the last `final` row is the committed `final.json` / `final.md` result. Iteration JSON/MD files
(iter1, iter2, ...) are kept separately.

Rows predating the split into page-level and run-start first-block latency repeat their single
measurement in both timing columns; the second value was not recorded in those runs.

| label                 | pages | skipped prose | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block from page ms | first block from run ms | full ms |
| --------------------- | ----: | ------------: | -----------------: | -------------: | -------------: | ----------: | -----------: | ------------: | -----------------------: | ----------------------: | ------: |
| baseline              |     5 |             1 |              13.8% |          20.9% |          0.84% |       0.000 |        0.062 |         98.3% |                      307 |                     307 |     909 |
| final (legacy metric) |     5 |             — |         0.0% (old) |          10.8% |          0.28% |       0.000 |        0.046 |         98.3% |                      261 |                     261 |     823 |
| ocr-iter              |     5 |             — |               0.0% |           4.3% |          0.24% |       0.000 |        0.175 |         89.6% |                      295 |                     295 |     896 |
| ocr-iter2             |     5 |             — |               0.0% |          10.8% |          0.28% |       0.000 |        0.046 |         98.3% |                      244 |                     244 |     794 |
| final (r1)            |     5 |             — |               0.0% |          10.8% |          0.28% |       0.000 |        0.046 |         98.3% |                      261 |                     261 |     823 |
| final (r2)            |     5 |             — |               0.0% |          10.8% |          0.28% |       0.000 |        0.046 |         98.3% |                      245 |                     245 |     791 |
| final (r3)            |     5 |             — |               0.0% |           6.7% |          0.24% |       0.000 |        0.066 |         97.9% |                      274 |                     274 |     859 |
| final (r4)            |     5 |             2 |               1.9% |           6.7% |          0.24% |       0.000 |        0.066 |         97.9% |                      316 |                     316 |     930 |
| final (pre-v6)        |     5 |             1 |               1.3% |           8.8% |          0.25% |       0.000 |        0.082 |         96.5% |                      284 |                     284 |     866 |
| final (v6)            |     5 |             0 |               1.2% |           0.0% |          0.04% |       0.000 |        0.000 |         98.3% |                      248 |                     248 |     779 |
| final (pre-review)    |     5 |             1 |               1.3% |           0.0% |          0.04% |       0.000 |        0.099 |         98.3% |                      342 |                     342 |    1029 |
| final (r5)            |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.100 |         98.3% |                      332 |                     332 |     998 |
| final (r6)            |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                      366 |                     366 |    1107 |
| final (r7)            |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                      313 |                     313 |     917 |
| final (r8)            |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        6 |                       6 |     852 |
| final                 |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        6 |                       6 |     937 |
| final                 |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        5 |                     349 |     954 |
| final                 |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        5 |                     300 |     920 |
| final                 |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        6 |                     350 |     988 |
| final                 |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        7 |                     327 |     878 |
| final                 |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        7 |                     305 |     866 |
| final                 |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        6 |                     290 |     909 |
| final                 |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        6 |                     295 |     887 |
| final                 |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        6 |                     318 |     934 |
| final                 |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        6 |                     268 |     799 |
| final                 |     5 |             0 |               0.0% |           0.0% |          0.04% |       0.000 |        0.024 |         98.3% |                        5 |                     378 |     968 |
