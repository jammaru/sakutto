# Page bench — mock-baseline-3eeb1a8

- Mode: mock
- Commit: `1cfaf589799bcbcc565397eda6ba5df693243aee` (dirty working tree)
- Started: 2026-11-06T13:47:22.366Z
- Fixtures: 7, samples per fixture: 2

| Page                           | First visible text (ms) | Viewport done (ms) | Full page (ms) | Blocks/s | Output chars | Engine |
| ------------------------------ | ----------------------: | -----------------: | -------------: | -------: | -----------: | ------ |
| long-article                   |                     125 |                950 |           3850 |     11.7 |         7690 | mock   |
| first-paragraph-then-long-tail |                     100 |                650 |           3050 |      8.7 |         6466 | mock   |
| many-cards                     |                    87.5 |               2150 |           2400 |     24.3 |         2931 | mock   |
| single-long-paragraph          |                     150 |               1225 |           1225 |      2.6 |         2998 | mock   |
| model-card-sidebar             |                     225 |                975 |         2162.5 |     20.9 |         2872 | mock   |
| mixed-ui                       |                     100 |               1025 |           1875 |     23.6 |         2136 | mock   |
| late-mount-spa                 |                     100 |               1625 |           1800 |      8.1 |         1750 | mock   |

## Headline numbers (long-article)

Engine: **mock translator** · mode `mock` · commit `1cfaf58` · dirty tree

| Metric                                     | Value |
| ------------------------------------------ | ----: |
| Time to first visible translated paragraph | 0.1 s |
| Full page translated                       | 3.9 s |
| Remaining work after the first paragraph   | 3.7 s |

Only these two numbers belong in a tweet, and only from a `live` run. Mock numbers
measure the scheduler, not the model.

Mock mode replaces the model with an in-page stub, so these durations describe
scheduling, DOM painting, batching and harness overhead — not translation speed.
They are only comparable with other mock runs.
