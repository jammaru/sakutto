# Page bench — webgpu-swa-full

- Mode: live
- Commit: `4516dc99fefa8ac02b4e80357ac75b8341758f60`
- Started: 2026-11-08T15:33:44.917Z
- Fixtures: 1, samples per fixture: 3

| Page         | First visible text (ms) | Viewport done (ms) | Full page (ms) | Blocks/s | Output chars | Engine |
| ------------ | ----------------------: | -----------------: | -------------: | -------: | -----------: | ------ |
| long-article |                     527 |               5301 |          14850 |        3 |         2917 | webgpu |

## Headline numbers (long-article)

Engine: **WebGPU** (8 threads) · mode `live` · commit `4516dc9`

| Metric                                     |  Value |
| ------------------------------------------ | -----: |
| Time to first visible translated paragraph |  0.5 s |
| Full page translated                       | 14.8 s |
| Remaining work after the first paragraph   | 14.3 s |

Compared with `webgpu-2seq-e72a60d` (WebGPU):

| Metric                                     | Before (s) | After (s) | Change |
| ------------------------------------------ | ---------: | --------: | -----: |
| Time to first visible translated paragraph |        1.1 |       0.5 | -53.2% |
| Full page translated                       |       21.6 |      14.8 | -31.1% |

These are the two numbers to cite from a `live` run. Mock numbers measure the
scheduler, not the model, and must not be presented as translation speed.

Compared with run `webgpu-2seq-e72a60d`:

### First visible translated text

| Page         | Before (ms) | After (ms) | Delta | Change |
| ------------ | ----------: | ---------: | ----: | -----: |
| long-article |        1127 |        527 |  -600 | -53.2% |

### Visible viewport translated

| Page         | Before (ms) | After (ms) | Delta | Change |
| ------------ | ----------: | ---------: | ----: | -----: |
| long-article |        7601 |       5301 | -2300 | -30.3% |

### Whole page translated

| Page         | Before (ms) | After (ms) | Delta | Change |
| ------------ | ----------: | ---------: | ----: | -----: |
| long-article |       21551 |      14850 | -6701 | -31.1% |

### Blocks committed per second

| Page         | Before (blocks/s) | After (blocks/s) | Delta | Change |
| ------------ | ----------------: | ---------------: | ----: | -----: |
| long-article |               2.1 |                3 |  +0.9 | +42.9% |

For every timing row, a negative delta means the page finished faster and a negative
percentage is the improvement. For blocks/s, higher is better.
