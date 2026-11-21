# Caption quality harness

`pnpm caption:quality` runs a deterministic Playwright harness against the local fake
YouTube player. It samples the Sakutto caption overlay while the media playhead advances,
then fails on any caption-quality metric that crosses its threshold.

## Run locally

```bash
# Node 24 + pnpm 12.15.0; the e2e build uses the fake translation engine.
pnpm caption:quality

# Optional: save raw samples, per-run metrics, failure/pass frames and a video.
CAPTION_QUALITY_ARTIFACTS=/path/to/artifacts CAPTION_QUALITY_VARIANT=local \
  pnpm caption:quality
```

The script reuses `scripts/run-e2e.mjs`, so it builds `.output/chrome-mv3` with
`SAKUTTO_FAKE_ENGINE=1` and installs Chromium unless `PLAYWRIGHT_SKIP_INSTALL=1` is set.
No real model, network caption endpoint, or install-time host permission is involved.
The fake engine translates by prefixing the source with `§<target>§`; the page sets
`data-bench-pace={"ttfbMs":80,"msPerChar":0,"deltas":0}` so there is a small, fixed
80 ms prefill and no streaming-delta churn. Normal (non-e2e) translation is untouched.

## Fixture and scenario

- `e2e/fixtures/youtube-quality.html` — a fake watch page with `#movie_player`,
  `ytInitialPlayerResponse`, a native caption window, and unrelated page copy. The
  dummy MP4 is loaded from a blob URL so Chromium can seek it (the static fixture server
  does not serve byte ranges).
- `e2e/fixtures/youtube-quality-ja.json` / `-en.json` — json3 ASR tracks whose rolling
  windows drop their leading words (`"The station opens" → "station opens at dawn."`).
  A correct implementation rolls these into whole sentences; a fragment-based one emits
  duplicated text such as `"The station opens at station opens at dawn."`.
- `e2e/caption-quality-helpers.ts` — a 50 ms page-side sampler over the overlay host,
  its shadow lines, the native caption window, the player rect, and the playhead. It
  drives normal play, forward/back seek, pause/resume, a tail seek, and 1.5x/2.0x playback,
  then computes the metrics below. Scenario steps marked `seek: true` are _pure seeks_
  (measured for seek-settle only); steps that merely set `seekMs` to reposition the
  playhead before playing (tail, rate runs) are measured for show-latency and cue-advance
  instead.
- `e2e/caption-quality.spec.ts` — runs the same scenario for Japanese → English and
  English → Japanese, injects decoy page copy, and asserts every metric passes.

## Metrics and thresholds

| Metric                        | Threshold                                   | Why                                                                                                     |
| ----------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Complete sentence units       | ≤8% of active frames, ≤250 ms partial dwell | No flicker through ASR fragments or duplicated rolling windows                                          |
| All four sentences observed   | 4/4                                         | Every unit must reach the overlay                                                                       |
| Show latency (1x / 1.5x / 2x) | ≤250 ms from playhead crossing cue start    | Includes 50 ms sampling slack; 80 ms fake-engine prefill                                                |
| Seek settle                   | ≤400 ms                                     | Forward/backward seeks only; pure seek steps repaint promptly                                           |
| Cue advance (no stale text)   | ≤400 ms after the next cue starts           | All play phases incl. tail after its seek; a finished line is held only through real silence (2 s hold) |
| Jump-back / rollback          | 0 frames                                    | A committed sentence must not reappear during a later unit                                              |
| Overlay isolation             | 0 decoy leaks                               | Page copy must never enter caption attributes or shadow lines                                           |
| Layout                        | 0 overflow frames, ≤2 visible lines         | Overlay stays inside the player; one translated + one original line                                     |
| Native captions hidden        | 0 frames                                    | Native window must be hidden while Sakutto paints                                                       |

Show latency used to be bounded by `timeupdate` (~4 Hz). `src/captions/session.ts` now
polls the playhead every 50 ms while playing (`paint(false, true)`, skipping layout work)
so a cue change paints at frame-like cadence. The 250 ms threshold was **not** relaxed.

The show-latency and cue-advance timings are attributed by phase: normal play crosses the
second and third cues at 1x, the tail step crosses the final cue after seeking to 6.1 s,
and the rate steps rewind to 0 and cross the second cue at 1.5x and 2x. Only the two pure
seek steps contribute to seek-settle; their `seekMs` repositions plus the mark lets the
analyser keep the two measurements separate. The per-sentence latency detail in the
metrics JSON is prefixed with its phase (e.g. `rate-2:…=…`).

## Baseline comparison workflow

1. Run the harness on the fixed commit and save `metrics-head-*.json`.
2. Create a separate worktree at the bad commit:
   `git worktree add --detach /tmp/baseline 804a48e`.
3. Copy the harness files listed above into that worktree (including the modified
   `e2e/extension.ts` for optional video capture), symlink `node_modules`, build with
   `SAKUTTO_FAKE_ENGINE=1 pnpm exec wxt build`, then run the same spec with
   `CAPTION_QUALITY_VARIANT=baseline pnpm exec playwright test e2e/caption-quality.spec.ts`.
4. Compare the per-metric JSON files. On 804a48e the rolling-window windows are merged as
   separate fragments, so sentence-units, partial dwell, all-sentences, show latency and
   seek settle fail; overlay isolation, layout and native hiding still pass.

The artifacts produced for PR 147 are summarized in
`/cursor/stores/bc-df1ba74e-ebfd-59a3-80e9-0569718830e5/artifacts/caption-quality/metrics-before-after.md`.
