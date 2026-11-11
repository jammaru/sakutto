# Page bench — PR #67 GPU sampling (turned off)

Maintainer measurement of PR #67 head `0e3182c` against main `36c20ee`. GPU-side
greedy sampling (`backend_sampling: true`) was about **4.1× slower** than main, so
this tree no longer sends that flag. Pending-result drain (`0010`) stays.

Do not treat these seconds as a promise of extension speed. They are one machine.

## Conditions

- OS: Windows
- GPU: RTX 4070 Ti SUPER
- Browser: Chromium through Playwright
- Engine: WebGPU, `--tier g` (16 concurrent, integer dot product)
- Model: plamo-3-translate-0.8b Q4_K_M
- Command: `scripts/bench/pages-run.ts --mode live`, alternating 6 runs each
- Commits: main `36c20ee` vs PR #67 `0e3182c`

## long-article (45 blocks)

Median, range in parentheses.

| Metric         |     main `36c20ee` |          PR `0e3182c` |
| -------------- | -----------------: | --------------------: |
| Full page      | 3.74 s (3.68–3.95) | 15.39 s (15.14–15.65) |
| First sentence |             0.30 s |                0.39 s |

## 23-block page

Reported as main 1.48 s / 1.23 s vs PR 4.43 s / 4.15 s.

## Output

- PR WebGPU output was **byte-identical** to main WebGPU in every run (45/45 and
  23/23). No CPU fallbacks.
- WebGPU vs CPU already differ in 17–18 of 45 `long-article` blocks on **main**,
  and the same on the PR. GPU greedy is not the same as CPU greedy.
- Isolation: a local PR build with only `backend_sampling: true` removed for
  WebGPU returned to about **4.20 s** median (that build as-is 16.18 s). So the
  slowdown is the GPU sampling / argmax path, not the pending-result patch.
- That isolation build (`samplers: ['temperature']` without `backend_sampling`)
  differed from main in 6–9 blocks (example: p4 「議論のあり方」→「議論の様相」).
  Not acceptable.
- The pending-result drain showed **no measurable gain** on this RTX.

## Why 2-1 is slower (code)

Pinned llama.cpp `5aeac37`. WebGPU `get_tensor_async` is NULL, so
`ggml_backend_tensor_get_async` synchronizes and then
`ggml_backend_webgpu_buffer_get_tensor` does CopyBufferToBuffer + map + unmap
for **each** tensor. Temperature-0 with `samplers: ['temperature']` still emits
three 4-byte tensors per slot (token, logit, candidate) — 12 bytes and three
reads per slot, as issue #61 described. Sixteen parallel slots → 48 GPU
round-trips per decode, versus one batched full-vocab copy on main.

`llama_set_sampler` always sets `sched_need_reserve`. Slot launch sets a
sampler; slot reset sets `nullptr`. Each start/end rebuilds the graph
(`synchronize` + reserve). Issue #61's 2-2 (one batched token-id read) and 2-3
(keep a sampler on every slot) are the pieces that would avoid this. They were
not public and are not in this tree.

## What this tree does now

- Keep `0010-return-pending-results.patch` (return order only; tokens unchanged).
- Do not send `backend_sampling` or `samplers`.
- Do not ship the WebGPU argmax tie-break patch; it only matters on the slow path.

A wllama rebuild is required after dropping the argmax patch
(`pnpm build:wllama` then `pnpm verify:wllama`).
