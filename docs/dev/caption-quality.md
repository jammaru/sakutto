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
- `e2e/fixtures/youtube-quality-asr.html` / `-asr.json` — a live YouTube-style ASR track.
  Native json3 chunks grow every 600 ms and carry sentinel noise (`S1`, `ED`, `E`, `NC`,
  `RS`), a stutter (`in a in a`), a `[Music]`-only cue and a lyric line. The fake engine can
  echo marker tokens left in a prompt (`data-bench-echo-markers`) and counts sound tags that
  were sent to the model (`data-bench-sound-tag-translations`). Neither knob exists in release
  builds.
- `e2e/caption-quality-asr-helpers.ts` — four extra metrics for the auto-generated path;
  latency is attributed to the first sampled change of the native caption text, not to the
  media start time shared by rolling json3 windows.

## Metrics and thresholds

| Metric                         | Threshold                                   | Why                                                                                                     |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Complete sentence units        | ≤8% of active frames, ≤250 ms partial dwell | No flicker through ASR fragments or duplicated rolling windows                                          |
| All four sentences observed    | 4/4                                         | Every unit must reach the overlay                                                                       |
| Show latency (1x / 1.5x / 2x)  | ≤250 ms from playhead crossing cue start    | Includes 50 ms sampling slack; 80 ms fake-engine prefill                                                |
| Seek settle                    | ≤400 ms                                     | Forward/backward seeks only; pure seek steps repaint promptly                                           |
| Cue advance (no stale text)    | ≤400 ms after the next cue starts           | All play phases incl. tail after its seek; a finished line is held only through real silence (2 s hold) |
| Jump-back / rollback           | 0 frames                                    | A committed sentence must not reappear during a later unit                                              |
| Overlay isolation              | 0 decoy leaks                               | Page copy must never enter caption attributes or shadow lines                                           |
| Layout                         | 0 overflow frames, ≤2 visible lines         | Overlay stays inside the player; one translated + one original line                                     |
| Native captions hidden         | 0 frames                                    | Native window must be hidden while Sakutto paints                                                       |
| Marker leak (ASR)              | 0 frames                                    | No S1/ED/E/T/NC/RS token in caption attributes or shadow lines                                          |
| Sound-tag translations (ASR)   | 0 calls/frames                              | Pure [Music]/♪ cues must be dropped without a model call                                                |
| Stutter English leftover (ASR) | 0 frames                                    | Repeated English words must be collapsed before translation                                             |
| ASR show latency               | ≤400 ms worst                               | Japanese overlay within 400 ms of each native chunk appearing                                           |

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
   `git worktree add --detach /tmp/baseline ce3b0f4`.
3. Copy the harness files listed above into that worktree (including the modified
   `e2e/extension.ts` for optional video capture), symlink `node_modules`, build with
   `SAKUTTO_FAKE_ENGINE=1 pnpm exec wxt build`, then run the same spec with
   `CAPTION_QUALITY_VARIANT=baseline pnpm exec playwright test e2e/caption-quality.spec.ts`.
4. Compare the per-metric JSON files. On ce3b0f4 the rolling-window windows are merged as
   separate fragments, so sentence-units, partial dwell, all-sentences, show latency and
   seek settle fail; overlay isolation, layout and native hiding still pass.

The ASR auto-generated scenario is a third test in the same spec. It drives a live
`kind=asr` fixture, samples at 50 ms, and fails on any of the four new metrics. At 33911df
(with the harness extension) all four fail: marker-leak 36 frames, sound-tag translations 11,
stutter leftover 54 frames, and unbounded show latency. On this branch they are 0/0/0 and
100 ms (50 ms sampling slack), while the ten legacy metrics still pass. The sound-tag metric
also inspects the original overlay attribute, not only the translated caption.

The artifacts produced for PR 147 are summarized in
`/cursor/stores/bc-df1ba74e-ebfd-59a3-80e9-0569718830e5/artifacts/caption-quality/metrics-before-after.md`
and, for this ASR round, in
`/cursor/stores/bc-df1ba74e-ebfd-59a3-80e9-0569718830e5/artifacts/caption-quality-asr/metrics-before-after.md`.

## Realistic feel-test scenario (owner-style ASR)

The legacy pace (80 ms prefill, zero decode) measures only the in-process hop. It cannot
reproduce the owner's 0.25–2.5 s lag, because a real on-device engine has a warmup, decodes
per character, and queues requests behind earlier work. `pnpm caption:quality` now runs a
fourth test in the same spec:

- `e2e/fixtures/youtube-feeltest-asr.html` / `.json` — a live `kind=asr` player that repaints
  rolling YouTube-style windows with owner phrases ("I had some technical difficulties",
  "I'm Lydia", "the Cloud Code team at Anthropic", "Opus 55", "Fable 52"). Windows grow,
  shift by dropping leading words, and start new sentences, so a tail-only translator drops
  or repeats clauses.
- The page sets `data-bench-pace={"ttfbMs":80,"msPerChar":7,"deltas":0,"warmupMs":250,
"concurrent":1,"markerFirstOnly":true}`: a one-off warmup, per-character decode and one
  engine slot. These knobs exist only in the fake engine used by the e2e build.
- `e2e/caption-quality-feeltest-helpers.ts` samples at 50 ms and reports six metrics. Lag is
  wall-clock from the first native window appearance to the first overlay line that covers
  it; skip/duplicate rates are fractions of active overlay frames.

| Metric                 | Threshold                      | What it catches                                              |
| ---------------------- | ------------------------------ | ------------------------------------------------------------ |
| e2e-lag-worst          | ≤2000 ms hard (1000 ms target) | Native word appearance → matching Japanese overlay           |
| skip-rate              | 0                              | Tail-only fragments / dropped clauses                        |
| duplicate-rate         | 0                              | Same semantic span translated twice                          |
| loading-text-in-stream | 0 frames                       | `字幕を翻訳しています…` or `Translating caption…` in the bar |
| incomplete-ending      | 0 frames                       | Ellipsis-only or unfinished clause after a complete cue      |
| coverage-chunks        | all 12 chunks                  | Every rolling window reaches the overlay in order            |

The product answers this with an incremental ASR stream (`src/captions/asr-stream.ts`):
rolling windows become word-boundary deltas, each delta is translated once with the committed
prefix as context, results are appended in order, and stale/in-flight work is dropped as the
playhead advances. Live ASR no longer paints `pending=true` mid-stream, and the last good
Japanese line stays visible while the next delta decodes. Human captions, marker/stutter/sound
cleanup and the page translation path are unchanged.

### Baseline comparison

With the same harness copied onto ce3b0f4 (product unchanged, fake-engine timing knobs
harness-only), the feel-test fails every new metric; on this branch all six pass:

| Metric                 | ce3b0f4   | this branch | threshold |
| ---------------------- | --------- | ----------- | --------- |
| e2e-lag-worst          | Infinity  | 500 ms      | ≤2000 ms  |
| skip-rate              | 0.0833    | 0           | 0         |
| duplicate-rate         | 0.1875    | 0           | 0         |
| loading-text-in-stream | 98 frames | 0           | 0         |
| incomplete-ending      | 98 frames | 0           | 0         |
| coverage-chunks        | 5 / 12    | 12 / 12     | 12        |
| legacy + ASR metrics   | all pass  | all pass    | —         |

Raw per-run metrics, samples and screenshots are written under
`CAPTION_QUALITY_ARTIFACTS` as `metrics-{baseline,head}-{ja,en,asr,feeltest}.json`.
The owner-derived lag analysis lives in
`/cursor/stores/bc-df1ba74e-ebfd-59a3-80e9-0569718830e5/artifacts/caption-quality-feeltest/owner-video-lag.md`;
the measured root-cause write-up is `/home/ubuntu/dsh-reports/feeltest-lag-root-causes.md`.

## Synthetic VOD json3 replay

`pnpm caption:quality` also runs `e2e/caption-quality-json3.spec.ts`. Use
`pnpm caption:quality:json3` for the focused suite. This is the phase-1 acceptance oracle for
offset-bearing, non-live ASR: it uses the real caption session, seekable media, the fake engine,
and the overlay. It does not replace any legacy VOD or live ASR scenario.

### Fixture provenance and independence

No real raw json3 capture is included. `youtube-vod-json3-en.json` is clearly synthetic and was
written from public-style YouTube json3 shapes, not copied from a watch page or generated by the
caption parser. Its rolling ASR windows contain event `tStartMs`/`dDurationMs`, per-segment
`tOffsetMs`, growing and shifted overlap, real pauses, punctuation, short cues, and decimal
spans split across segments. The source deliberately contains `5.5`, `5.2`, and `4.5`; it
does not imply that an upstream caption that already says `55` can be corrected without
separate evidence.

The local fixture is sanitized by construction: it has no signed caption URL, credential,
personal watch metadata, identifying URL, audio, or recorded video. The only track URL is a local
relative URL. Its SHA-256 is
`ee9f7b782f4006520061e92a1e44a3a08c29a1cd2dd7a349813e69f19f9219ce`; replay artifacts also
record the hash of the exact bytes used. `youtube-vod-json3-media.bin` contains seekable 24.3-second MP4 static media looped from the
existing dummy fixture. The page gives its blob an explicit MP4 MIME type.

`youtube-vod-json3-en.expected.json` is an independently hand-authored manifest, not parser
output. It records nine stable cue ids, source strings, source starts/ends, exact fake-engine
Japanese strings, and ordered numeric lexemes. A non-vacuous integrity test checks the manifest
against the raw timed-word coverage and requires overlap, offsets, pauses, short cues, and all
three decimals. Expected boundaries must not be regenerated from current product output.

`youtube-vod-json3.html` is non-live unless `?live=1` is explicit. In VOD mode its native DOM
caption is a mutating stale decoy; passing content and request checks therefore cannot be based
on native DOM scraping. The long-track scenario serves a deterministic 96-cue local json3 payload.
The live scenario uses an empty recent track, positive incremental DOM translation, and a VOD
scheduler spy; its existing timedtext/VTT fallback remains allowed.

### Replay mechanics and metrics

The fake engine uses 150 ms warmup, 80 ms prefill, 2 ms per character, and one decode slot. The
recorder samples every 50 ms and observes overlay attribute mutations. Continuous replay covers
0–22 seconds at 1x and observes the final cue beyond its minimum dwell. Interaction replay covers
warm play, forward seek, cached rewind, pause/resume, 2x, and return to 1x. Fixed dwells only drive
the scenario; paint and dwell evidence comes from mutations and interpolated media crossings.

| Metric           | Exact rule                                                                                                                                      | Target                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Cue-start lag    | First exact matching JA mutation minus linearly interpolated wall crossing of the independent source start; linear-interpolation median and p95 | median ≤300 ms, p95 ≤1,000 ms                                                                    |
| Missing lag      | A missing crossing or JA paint contributes `Infinity`; early paint is a separate failure and is never clamped to zero                           | zero missing/early cues                                                                          |
| JA dwell         | Each contiguous mutation-to-mutation visibility interval for every expected JA cue, including a flash followed by a repaint                     | every uncensored interval ≥1,200 ms                                                              |
| Content          | Ordered first appearances and interval counts for both source and JA, plus missing and unexpected/partial strings                               | zero missing, duplicate, reordered, or partial units                                             |
| Numeric fidelity | Ordered source numeric lexemes compared with the matching JA cue; decimals split by spaces or across cues do not match                          | exact `5.5`, `5.2`, `4.5`; no `55`, `52`, `45` substitutions                                     |
| Track requests   | Requests for the selected local track, counted by `fmt`                                                                                         | one json3 GET and zero VTT GETs in VOD, including seek/rate                                      |
| Scheduler        | Start/abort/finish/cache-hit counts, computed outstanding maximum, initial-load starts, generation, priority, mode, and decoy source text       | at most four outstanding/initial requests, urgent work before far work, no DOM-decoy translation |
| Live isolation   | Positive incremental JA paint plus VOD scheduler/request mode spy                                                                               | zero VOD scheduler activity in live mode                                                         |

Seek/source transitions censor the previously active dwell interval and report it separately;
they never turn a short interval into a pass. Pause samples must not advance the playhead or clear
the active caption. Rewind must produce a cache hit, and seek/rate phases must request the
destination first and advance the scheduling generation without another track GET. Artifacts
preserve non-finite values as the strings `Infinity`/`-Infinity` rather than JSON `null`.

The 1,200 ms dwell, no-drop, and latency targets can conflict when cue starts are closer than
1,200 ms in wall time. At 2x that means 2,400 ms of media spacing. The harness reports the backlog
and failed lag; it never skips a cue or shortens dwell to make dense/rate scenarios pass.

### Scheduler trace contract and baseline gaps

The phase-1 recorder listens for document `CustomEvent`s so later scheduler phases can expose
actual product work without a second fake scheduler:

- `sakutto:caption-request`: `action` (`start`, `abort`, `finish`, or `cache-hit`),
  `cueId`, `sourceText`, `generation`, `priority`, `mode`, and `reason`;
- `sakutto:vod-scheduler`: `generation`, `reason`, `mode`, `cueCount`, and
  `outstanding`.

The recorder adds wall time, media time, phase, and epoch. An empty trace is **not** a zero-burst
pass: non-live acceptance fails with `translation/scheduler instrumentation is missing`.

At the 5ddaaee product baseline, the continuous replay is runnable and records exactly one json3
GET and zero VTT GETs, but all nine independently expected JA cues are missing, cue-lag
median/p95 are `Infinity`, numeric checks fail, and scheduler instrumentation is absent. The
continuous, interaction, and long-track assertions therefore fail for product reasons rather
than being weakened or skipped. The live scenario independently requires a real incremental JA
paint so its zero-VOD-trace assertion is non-vacuous.

With `CAPTION_QUALITY_ARTIFACTS` set, each scenario writes
`json3-metrics-{variant}-{scenario}.json` and
`json3-trace-{variant}-{scenario}.json`; failed continuous/interaction runs also save a
screenshot. Traces include samples, display transitions, request events, scheduler events, and
network counts.
