# Page translation bench

A durable way to answer one question: **did translating a page get faster than it was at the
last commit?**

It loads the unpacked Chrome MV3 extension in Chromium through Playwright, opens the same set of
fixture pages a user would open, asks for a page translation the way the popup and the `Alt+A`
shortcut do, and records the timings into `bench/history/pages.jsonl`. Because every run appends
to the same file, a run after a speed change can be compared with the run before it on identical
pages.

Speed is the project's first product value, so the numbers are kept rather than printed once.

## The pages

The fixtures are plain standalone HTML with no external requests, so they render anywhere.

**To translate one yourself, serve them** — the extension only runs on `http:`/`https:` pages,
so a `file://` tab will render the page but Sakutto will not attach to it:

```sh
pnpm bench:serve            # http://127.0.0.1:4180/ lists every fixture
```

Or open any file under `bench/pages/` in a static server of your choice. Then press `Alt+A` (or
use the popup) with the unpacked extension loaded.

- `bench/pages/long-article.html`
- `bench/pages/many-cards.html`
- `bench/pages/single-long-paragraph.html`
- `bench/pages/model-card-sidebar.html`
- `bench/pages/mixed-ui.html`
- `bench/pages/late-mount-spa.html`

| Page                    | Pattern                                                                 | Bottleneck it isolates                                                                                 |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `long-article`          | Long research/news article, 22 paragraphs in 4 sections, plus a sidebar | Sustained prefill and decode over realistic prose. The default "is it faster" page.                    |
| `many-cards`            | 12 cards, each a kicker + heading + paragraph + meta line               | Per-block overhead: batching, packing and scheduling many tiny blocks instead of raw token throughput. |
| `single-long-paragraph` | One paragraph of ~2,900 characters                                      | The sentence splitter and chunk scheduling. The block cannot finish until its last chunk lands.        |
| `model-card-sidebar`    | README prose in the main column, short metadata labels in a sidebar     | Chrome/metadata prioritisation against body copy, plus a sidebar the old collector dropped.            |
| `mixed-ui`              | Settings screen: navigation, labels, help paragraphs, values, buttons   | Mixed short/long blocks where most text is small — the everyday app UI case.                           |
| `late-mount-spa`        | Content injected 1.2 s after first paint, plus a `pushState` link       | Rescanning, the mutation observer, and whether late blocks reuse a warm runtime.                       |

Every fixture is original English prose written for this repo. No article text is copied from
Anthropic, Hugging Face or Wikipedia, so the fixtures stay under the project's MIT license and
outside the package-audit rules for the CC BY-SA `kyoto.html` page.

Blocks the bench follows carry `data-bench-id` and `data-bench="prose|heading|ui|code"`. The
recorder only reads the DOM; the extension translates through its normal content script, so a
recorded run is a real user-visible run.

## Running it

Both modes need a Chromium that Playwright can drive (`pnpm exec playwright install chromium`),
because branded Chrome refuses `--load-extension`.

### Mock mode — default, no model download

```sh
pnpm bench:build:mock      # fake in-page translator, no wasm/model needed
pnpm bench:mock            # ~30 s for all six pages
pnpm bench:mock --only long-article
pnpm bench:mock --samples 3
```

### Live mode — the real PLaMo model and the real runtime

```sh
pnpm build:wllama          # once, needs Docker; see docs/BUILDING.md
pnpm bench:build:live      # SAKUTTO_E2E_REAL=1 build: scripts the local pages, real engine
pnpm bench:live            # downloads the pinned GGUF to bench/.cache/ on first use
```

The GGUF (573 MB) is fetched once, SHA-256 checked, and served to the extension from disk so the
browser never hits the network mid-run. `--model <path>` points at a copy you already have.
`--samples N` repeats every page; the summary reports the median.

Live mode is opt-in exactly like `SAKUTTO_E2E_REAL=1` for `pnpm test:e2e`: it is never part of CI.

### Reading the numbers afterwards

```sh
pnpm bench:history                     # newest run vs the one before it
pnpm bench:history --summary <run>     # rebuild one run's markdown
pnpm bench:history --baseline <a> --compare <b>
```

`bench/results/pages/<run>.md` is written by every run and holds the same tables; the JSONL file is
the source of truth.

## What is recorded

One JSON line per page per repetition in `bench/history/pages.jsonl` (`schema: 1`):

| Field                                                                          | Meaning                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `run`, `at`, `page`, `sample`, `samples`                                       | Which invocation, when, which fixture, and which repetition.                                     |
| `mode`                                                                         | `mock` or `live`. Mock and live numbers must never be compared.                                  |
| `commit`, `dirty`                                                              | Full SHA of the tree the numbers came from, and whether it had uncommitted changes.              |
| `engine.label` / `backend` / `tier` / `threads` / `chromeTranslator` / `model` | Which engine answered, and whether Chrome's translator was available to draft.                   |
| `machine`                                                                      | Platform, core count, user agent, cross-origin isolation, viewport.                              |
| `metrics.firstTextMs`                                                          | Harness command to the first changed block of any kind.                                          |
| `metrics.firstVisibleTextMs`                                                   | Same, restricted to prose the reader could see without scrolling. **What a reader feels.**       |
| `metrics.viewportDoneMs`                                                       | Every prose block that was on screen when first seen has a finished translation.                 |
| `metrics.fullPageMs`                                                           | Every followed block finished. `null` when the run timed out.                                    |
| `metrics.commitsPerSecond`                                                     | Blocks finished per second between first text and completion. Comparable in both modes.          |
| `metrics.outputChars`                                                          | Characters that landed in the DOM.                                                               |
| `metrics.estimatedOutputTokensPerSecond`                                       | `outputChars × 0.447 / s`. Live mode only; an estimate, not a tokenizer call.                    |
| `metrics.reportedRate`                                                         | The rate the page overlay itself printed, verbatim (the `sakutto-perf` hook).                    |
| `metrics.blocks`                                                               | Total tracked blocks, split by prose / heading / UI / code, plus how many were visible/finished. |
| `metrics.lateBlocks`                                                           | Blocks that entered the DOM after the run started.                                               |
| `metrics.engines`                                                              | How many blocks carry each `data-sakutto-engine` value.                                          |
| `metrics.codeUntouched`                                                        | Whether literal `code` blocks kept their exact source text.                                      |
| `metrics.state` / `progress` / `timedOut`                                      | The `data-sakutto-state` the page settled in, the progress label, and whether it stalled.        |

`metrics.blocks.code` is excluded from the finished count: literal code must not be translated.

## Mock vs live, and what mock can actually measure

The fake in-page translator returns the source text immediately, so an unpaced mock run finishes
every page in one tick and no scheduling change can move the clock. Mock mode therefore sets a
synthetic, **deterministic** cost on the fake engine (`ttfbMs: 12`, `msPerChar: 0.35`, three
streaming deltas) proportional to the text length. That makes mock numbers describe:

- sentence splitting and chunking,
- batch packing, concurrency and priority ordering,
- DOM painting and the repaint cadence,
- harness and content-script overhead,

and **not** model speed. A mock run is roughly a tenth as long as a live one. Every mock record is
labelled `mode: "mock"`, carries a note saying so, and the summary repeats the warning.

Live mode is the only mode whose tok/s describes the model. Both modes run with Chrome's built-in
translator disabled so a draft never stands in for the engine under test.

## CI

`.github/workflows/ci.yml` runs the mock bench inside the existing `pnpm test:e2e` job
(`e2e/bench.spec.ts`). It downloads no model and asserts that:

- every fixture loads and the unpacked extension translates it,
- the record matches the `schema: 1` shape,
- a metric is emitted for every page (first text, full page, blocks/s, output chars),
- the page settles in `translated`, every non-code block finished, and nothing times out,
- the late-mount page really does pick up the injected blocks,
- the commit stamped into the record is a real SHA.

Live model runs are not in CI: they need a 573 MB download, WebGPU or several CPU cores, and they
are slow enough to be flaky on shared runners.

## Adding a fixture

1. Write a standalone HTML file in `bench/pages/` with `<html lang="en">`, no external requests.
2. Mark the blocks to follow with `data-bench-id` and `data-bench="prose|heading|ui|code"`. Put the
   attributes on the element the extension translates (a `<p>`, `<li>`, `<h2>`), not on a `<span>`
   inside it; the recorder also resolves an owning block, but a real block keeps the numbers exact.
3. Register it in `scripts/bench/pages.ts` with a one-line `stresses` note.
4. Run `pnpm bench:mock --only <name>` and `pnpm vitest run tests/bench-fixtures.test.ts`.

## History and the checked-in sample

`bench/history/pages.jsonl` starts with one **mock** sample captured while this suite was being
written, on the merge base of the branch (`3eeb1a8`, 4-core Linux VM, headless Chromium 156,
`--samples 2`). Its records say `"mode": "mock"` and `"dirty": true`, because the working tree
held the uncommitted suite itself. It is not a claim about model speed; it exists so the expected
shape of a run is visible and so `pnpm bench:history` has something to print.

No live PLaMo run is checked in. The VM used to write this suite has no Docker daemon to build the
pinned wllama wasm and no model in `bench/.cache/`, so the real-runtime numbers were not taken
here. Run `pnpm bench:live` on a machine with the wasm build to add the first live line.

Because a mock sample is already checked in, an automatic comparison only considers runs of the
same mode, and `pnpm bench:history` warns when a comparison spans modes. Keep mock and live runs
under different `--run` labels and never compare across `mode`.

## Relationship to the older model bench

`pnpm bench` (`scripts/bench/run.ts`) is unchanged in purpose: it probes the raw model and its
scheduler on four synthetic pages. It shares the model download, model route, settings and status
helpers in `scripts/bench/host.ts` with this suite. Use it to answer "what is the engine capable
of"; use `pnpm bench:live` to answer "what does a user wait for on this page".
