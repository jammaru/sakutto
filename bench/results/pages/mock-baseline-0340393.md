# Page bench — mock-baseline-0340393

- Mode: mock
- Commit: `2fc966c1b9494bf9fafb89e6bc3c891549186aca`
- Started: 2026-11-06T13:56:29.340Z
- Fixtures: 7, samples per fixture: 2

| Page                           | First visible text (ms) | Viewport done (ms) | Full page (ms) | Blocks/s | Output chars | Engine |
| ------------------------------ | ----------------------: | -----------------: | -------------: | -------: | -----------: | ------ |
| long-article                   |                     125 |                950 |           3850 |     11.7 |         7690 | mock   |
| first-paragraph-then-long-tail |                     100 |                650 |           3050 |      8.7 |         6466 | mock   |
| many-cards                     |                      75 |               2150 |           2400 |     24.3 |         2931 | mock   |
| single-long-paragraph          |                     150 |               1225 |           1225 |      2.6 |         2998 | mock   |
| model-card-sidebar             |                     225 |                975 |           2175 |     20.7 |         2872 | mock   |
| mixed-ui                       |                     100 |               1025 |           1875 |     23.6 |         2136 | mock   |
| late-mount-spa                 |                     100 |               1625 |           1800 |        8 |         1750 | mock   |

## Headline numbers (long-article)

Engine: **mock translator** · mode `mock` · commit `2fc966c`

| Metric                                     | Value |
| ------------------------------------------ | ----: |
| Time to first visible translated paragraph | 0.1 s |
| Full page translated                       | 3.9 s |
| Remaining work after the first paragraph   | 3.7 s |

These are the two numbers to cite from a `live` run. Mock numbers measure the
scheduler, not the model, and must not be presented as translation speed.

Mock mode replaces the model with an in-page stub, so these durations describe
scheduling, DOM painting, batching and harness overhead — not translation speed.
They are only comparable with other mock runs.
