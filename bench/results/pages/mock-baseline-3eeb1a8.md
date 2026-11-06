# Page bench — mock-baseline-3eeb1a8

- Mode: mock
- Commit: `3eeb1a8f85578d5191fe4d8aefb3f9bd623cbb47` (dirty working tree)
- Started: 2026-11-06T13:29:42.835Z
- Fixtures: 6, samples per fixture: 2

| Page                  | First visible text (ms) | Viewport done (ms) | Full page (ms) | Blocks/s | Output chars | Engine |
| --------------------- | ----------------------: | -----------------: | -------------: | -------: | -----------: | ------ |
| long-article          |                     125 |                950 |           3850 |     11.7 |         7690 | mock   |
| many-cards            |                     100 |               2150 |           2400 |     24.3 |         2931 | mock   |
| single-long-paragraph |                   162.5 |               1225 |           1225 |      2.6 |         2998 | mock   |
| model-card-sidebar    |                     225 |              987.5 |           2175 |     20.9 |         2872 | mock   |
| mixed-ui              |                     100 |               1025 |           1900 |     23.4 |         2136 | mock   |
| late-mount-spa        |                     100 |               1625 |           1800 |      8.1 |         1750 | mock   |

Mock mode replaces the model with an in-page stub, so these durations describe
scheduling, DOM painting, batching and harness overhead — not translation speed.
They are only comparable with other mock runs.
