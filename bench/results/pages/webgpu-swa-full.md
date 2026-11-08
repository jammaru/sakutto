# Page bench — webgpu-swa-full

- Mode: live
- Commit: `d08e56afe159d793504ea806097228fe3773ac76`
- Started: 2026-11-08T16:44:27.713Z
- Fixtures: 1, samples per fixture: 3

| Page         | First visible text (ms) | Viewport done (ms) | Full page (ms) | Blocks/s | Output chars | Engine |
| ------------ | ----------------------: | -----------------: | -------------: | -------: | -----------: | ------ |
| long-article |                     525 |               5330 |          14626 |      3.1 |         2921 | webgpu |

## Headline numbers (long-article)

Engine: **WebGPU** (8 threads) · mode `live` · commit `d08e56a`

| Metric                                     |  Value |
| ------------------------------------------ | -----: |
| Time to first visible translated paragraph |  0.5 s |
| Full page translated                       | 14.6 s |
| Remaining work after the first paragraph   | 14.1 s |

Compared with `webgpu-2seq-e72a60d` (WebGPU):

| Metric                                     | Before (s) | After (s) | Change |
| ------------------------------------------ | ---------: | --------: | -----: |
| Time to first visible translated paragraph |        1.1 |       0.5 | -53.4% |
| Full page translated                       |       21.6 |      14.6 | -32.1% |

These are the two numbers to cite from a `live` run. Mock numbers measure the
scheduler, not the model, and must not be presented as translation speed.

Compared with run `webgpu-2seq-e72a60d`:

### First visible translated text

| Page         | Before (ms) | After (ms) | Delta | Change |
| ------------ | ----------: | ---------: | ----: | -----: |
| long-article |        1127 |        525 |  -602 | -53.4% |

### Visible viewport translated

| Page         | Before (ms) | After (ms) | Delta | Change |
| ------------ | ----------: | ---------: | ----: | -----: |
| long-article |        7601 |       5330 | -2271 | -29.9% |

### Whole page translated

| Page         | Before (ms) | After (ms) | Delta | Change |
| ------------ | ----------: | ---------: | ----: | -----: |
| long-article |       21551 |      14626 | -6925 | -32.1% |

### Blocks committed per second

| Page         | Before (blocks/s) | After (blocks/s) | Delta | Change |
| ------------ | ----------------: | ---------------: | ----: | -----: |
| long-article |               2.1 |              3.1 |    +1 | +47.6% |

For every timing row, a negative delta means the page finished faster and a negative
percentage is the improvement. For blocks/s, higher is better.
