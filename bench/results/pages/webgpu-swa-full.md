# Page bench — webgpu-swa-full

- Mode: live
- Commit: `cf13a44a9429c121d79695d97886dcd1784204a2` (dirty working tree)
- Started: 2026-11-08T15:30:32.271Z
- Fixtures: 1, samples per fixture: 3

| Page | First visible text (ms) | Viewport done (ms) | Full page (ms) | Blocks/s | Output chars | Engine |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| long-article | 577 | 5177 | 15102 | 3 | 2919 | webgpu |

## Headline numbers (long-article)

Engine: **WebGPU** (8 threads) · mode `live` · commit `cf13a44` · dirty tree

| Metric | Value |
| --- | ---: |
| Time to first visible translated paragraph | 0.6 s |
| Full page translated | 15.1 s |
| Remaining work after the first paragraph | 14.5 s |

Compared with `webgpu-2seq-e72a60d` (WebGPU):

| Metric | Before (s) | After (s) | Change |
| --- | ---: | ---: | ---: |
| Time to first visible translated paragraph | 1.1 | 0.6 | -48.8% |
| Full page translated | 21.6 | 15.1 | -29.9% |

These are the two numbers to cite from a `live` run. Mock numbers measure the
scheduler, not the model, and must not be presented as translation speed.


Compared with run `webgpu-2seq-e72a60d`:

### First visible translated text

| Page | Before (ms) | After (ms) | Delta | Change |
| --- | ---: | ---: | ---: | ---: |
| long-article | 1127 | 577 | -550 | -48.8% |

### Visible viewport translated

| Page | Before (ms) | After (ms) | Delta | Change |
| --- | ---: | ---: | ---: | ---: |
| long-article | 7601 | 5177 | -2424 | -31.9% |

### Whole page translated

| Page | Before (ms) | After (ms) | Delta | Change |
| --- | ---: | ---: | ---: | ---: |
| long-article | 21551 | 15102 | -6449 | -29.9% |

### Blocks committed per second

| Page | Before (blocks/s) | After (blocks/s) | Delta | Change |
| --- | ---: | ---: | ---: | ---: |
| long-article | 2.1 | 3 | +0.9 | +42.9% |

For every timing row, a negative delta means the page finished faster and a negative
percentage is the improvement. For blocks/s, higher is better.
