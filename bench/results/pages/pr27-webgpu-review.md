# Page bench — pr27-webgpu-review

- Mode: live
- Commit: `ce2a05f6b093a268e7ec4ece9e52b6ae687b4d6a`
- Started: 2026-11-09T07:19:51.739Z
- Fixtures: 2, samples per fixture: 3

| Page         | First visible text (ms) | Viewport done (ms) | Full page (ms) | Blocks/s | Output chars | Engine |
| ------------ | ----------------------: | -----------------: | -------------: | -------: | -----------: | ------ |
| long-article |                     325 |               2504 |           3950 |     11.6 |         2926 | webgpu |
| many-cards   |                     254 |               2102 |           2126 |     29.8 |         1267 | webgpu |

## Compared with main

Baseline: `webgpu-swa-full` (commit `d08e56a`, the same machine, mode, fixture set and
`--samples 3`). Both runs record 16 cores, Chromium 156 and a 1280×800 viewport, so the
pair is like for like.

### long-article

| Metric                        | main (ms) | this PR (ms) |  Delta | Change |
| ----------------------------- | --------: | -----------: | -----: | -----: |
| First visible translated text |       525 |          325 |   -200 | -38.1% |
| Visible viewport translated   |      5330 |         2504 |  -2826 | -53.0% |
| Whole page translated         |     14626 |         3950 | -10676 | -73.0% |
| Blocks committed per second   |       3.1 |         11.6 |   +8.5 |  +274% |

Against v1.0.2, the full page finishes 3.7× sooner (14.6 s → 4.0 s).

### many-cards is a recorder fix, not a speed-up

`main` records `fullPageMs: null` for all three samples, but the page did finish. In
`bench/results/pages/live-windows-09db364-20261107.md` every sample reads
`progress 57/57`, `state translated`, and `blocks.finished 56` of `blocks.total 57`.
The engine was done; the recorder was not.

The old completion test required the translated text to differ from the source:

```
const changed = text.length > 0 && text !== item.original;
if (changed && engine !== null && !pending) { ... }
```

`many-cards` has a block whose translation is the source itself (a two-character nav
label), so that block never counted and the run waited out its 180 s budget. This PR
changes the test to "the engine mark is present and the pending mark is gone", which is
what actually means finished.

So the 2126 ms here is not comparable to a 180 s timeout: `main` never measured this
page. `many-cards`, `model-card-sidebar` and `mixed-ui` all carry `timedOut: true` in the
v1.0.2 run for the same reason, and none of their numbers should be read as a baseline.
`long-article` is unaffected (every block changes), which is why that comparison stands.

## Headline numbers (long-article)

Engine: **WebGPU** (8 threads) · mode `live` · commit `ce2a05f`

| Metric                                     | Value |
| ------------------------------------------ | ----: |
| Time to first visible translated paragraph | 0.3 s |
| Full page translated                       | 4.0 s |
| Remaining work after the first paragraph   | 3.6 s |

These are the two numbers to cite from a `live` run. Mock numbers measure the
scheduler, not the model, and must not be presented as translation speed.
