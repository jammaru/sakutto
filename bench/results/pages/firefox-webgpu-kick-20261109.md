# Page bench — firefox-webgpu-kick-20261109

- Mode: live (manual Firefox; not the Chromium Playwright harness)
- Dated: 2026-11-09
- Browser: Windows Firefox 159.0
- GPU: RTX 4070 Ti SUPER
- Model: PLaMo 3 Translate 0.8B Q4_K_M
- Page: 5-block English page (4 paragraphs + heading)
- Output: identical on WebGPU kick off, WebGPU kick on, and CPU

The repo's `pnpm bench:live` harness loads Chromium. These rows were timed in Firefox by
hand, then written in the same headline shape as the other files in this directory. Cite
from `docs/FIREFOX.md` as well.

## Headline numbers (5-block English page)

| Path                               | First sentence | Full page | Rate           |
| ---------------------------------- | -------------: | --------: | -------------- |
| Firefox WebGPU, kick off           |         ~1.1 s | 8.4–9.0 s | ~11.6 tok/s    |
| Firefox CPU, 1 thread              |          2.7 s |    15.8 s | —              |
| Firefox WebGPU, kick on            |    0.55–0.83 s | 1.6–1.9 s | —              |
| Chrome WebGPU (same PC, same page) |              — |   ~0.86 s | reference only |

Compared with Firefox WebGPU kick off:

| Metric         |    Before |       After | Change          |
| -------------- | --------: | ----------: | --------------- |
| First sentence |    ~1.1 s | 0.55–0.83 s | about 2× sooner |
| Full page      | 8.4–9.0 s |   1.6–1.9 s | about 5× sooner |

What changed: the Firefox WebGPU kick (`queue.submit([])` while `mapAsync` waits) is now
default-on. It works around bug 1870699 (≈100 ms GPU completion polling). It does not change
model output. Any error restores the original GPU methods.

These are the two numbers to cite from this Firefox run. Do not paste Chrome Web Store or
Chromium-harness numbers into the AMO listing.
