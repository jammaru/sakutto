# Caption trace capture and replay

The caption replay harness exercises the real `VideoCaptionSession` with a fake DOM,
a virtual clock, and a deterministic fake translator. It does **not** download or scrape
YouTube, load a video, call a translation engine, or use the network. The player response
and ASR caption track are synthetic, and the track reader always returns an empty string.

Committed fixtures under `tests/fixtures/caption-traces/` are hand-written English and
Japanese ASR snapshots. The original fixtures use 1.5-second word spacing so even the 900 ms
fake request finishes. The `en-rollup.json` and `ja-rollup.json` fixtures grow run-on
sentences past 96 characters and through more than two wrapped lines, exercising vertical
roll-up and cancellation as well as ordinary growth. Do not put captured captions or other
real video data in that directory. Local captures belong in `traces/`, which is gitignored.

## Replay

On the repository's supported Node 24+ runtime:

```sh
node scripts/caption-replay.ts
```

Node 22 can run the same script with its TypeScript transform flag:

```sh
node --experimental-transform-types --no-warnings scripts/caption-replay.ts
```

By default, all four synthetic fixtures are replayed at 150, 400, and 900 ms translation
latency. The JSON written to stdout includes every 100 ms frame, all translation requests,
and metrics. A compact human-readable summary goes to stderr. Useful variants:

```sh
# One local capture and one latency
node scripts/caption-replay.ts --trace traces/local.json --latency 400

# Omit frame timelines from the JSON
node scripts/caption-replay.ts --metrics-only

# Save the full JSON report and print only the summary
node scripts/caption-replay.ts --out traces/replay-report.json
```

Run the regression tests with:

```sh
pnpm vitest run --configLoader runner tests/caption-replay.test.ts
```

The tests require stable width and height, no horizontal original movement outside a
roll-up, no horizontally clipped characters, no blank translation after the first translated
frame, and at least 400 ms dwell for every distinct visible translation. They also require at
most one completed translation per committed sentence and verify that every completed,
non-pending visible translation belongs to a request whose input is contained in the visible
original. The long fixtures must actually roll up, and translations must occur, so an empty
or short replay cannot pass vacuously.

## Trace format

A trace contains ordered, full-text snapshots of the native caption line. Successive
snapshots normally add one ASR word; an empty string marks silence. Timestamps are relative
milliseconds. `endMs` ends the input, and replay adds a 1.5 second drain interval.

```json
{
  "version": 1,
  "name": "synthetic-example",
  "sourceLanguage": "en",
  "targetLanguage": "ja",
  "videoId": "synthetic-example",
  "endMs": 2200,
  "events": [
    { "atMs": 200, "text": "The" },
    { "atMs": 700, "text": "The station" },
    { "atMs": 1200, "text": "The station opens." },
    { "atMs": 2200, "text": "" }
  ]
}
```

Metrics are defined as follows:

- **blank translation percentage:** active-source frames with no visible translation,
  divided by all active-source frames. The initial translation wait is included.
- **blank after first:** blank active-source frames after the first translated frame.
- **width/height changes:** changes between consecutive active, visible frames; initial
  overlay attachment and time hidden during silence are not changes.
- **original horizontal shifts:** changes in the original viewport's left edge between
  active, visible frames. A transition that rolls the wrapped viewport upward is excluded;
  the roll-up transition count is reported separately.
- **clipped original characters:** UTF-16 characters horizontally truncated from wrapped
  lines. Both the frame-summed count and per-frame maximum are reported. Whole lines above
  the intentional last-two-lines viewport are roll-up, not horizontal clipping.
- **committed-sentence rewrites:** distinct completed translations after the first for the
  same sentence-final or 96-character committed source. The committed sentence count and
  maximum translations per sentence make this assertion non-vacuous.
- **translation/original mapping:** active, visible, non-pending translated frames matched
  to a completed fake request whose input is contained in `data-sakutto-original`. The report
  includes eligible frames, successful mappings, and mismatches.
- **translation dwell:** duration of each run of the same non-empty visible translation,
  including short caption holds through silence. The minimum and median are calculated over
  those runs at 100 ms sampling resolution.
- **translation input lengths:** UTF-16 string lengths in request order.
- **cancellations:** in-flight fake translation requests whose abort signal fired.

The fake DOM gives live captions a fixed 576×72 px two-row rectangle. Leaving live layout
mode changes that rectangle, so session layout regressions remain observable without a
browser layout engine. Because happy-dom does not lay out text, `replay-geometry.ts` provides
a deterministic `white-space: normal`/`overflow-wrap: anywhere` model with a bottom-anchored
last-two-lines viewport. It records whole-line roll-ups and horizontal clipping without
pretending to be a browser font measurement engine.

Live ASR display is unit-at-once: the original appears only after a sentence unit commits,
and translation appears only for that same unit. During the fallback while a unit's
translation is pending, the overlay shows the current unit's original only. It never pairs
that original with another unit's translation. Earlier unit translations are not rewritten
after commit.

The baseline `f5130d6` harness used the same fixed live rectangle and did not model the old
horizontal tail-clipping CSS. Its width/height and continuity metrics are therefore directly
comparable, but zero shift/clipping values in the wrapped geometry are **not** a measured
before/after browser-rendering delta. Real font metrics and painted clipping still require a
browser layout check.

## Optional local capture (development only)

`startCaptionTraceRecorder` in `src/captions/trace.ts` is opt-in and has no automatic
caller. It observes caption DOM mutations only; it performs no fetch and does not control
playback. To make a one-off local capture, temporarily import it from development-only
content-entry code, start it after the caption session exists, and expose the stop function:

```ts
if (import.meta.env.DEV) {
  const { startCaptionTraceRecorder } = await import('../captions/trace');
  const recorder = startCaptionTraceRecorder(document, {
    name: 'local-capture',
    sourceLanguage: 'en',
    targetLanguage: 'ja',
  });
  Object.assign(window, { stopSakuttoCaptionTrace: recorder.stop });
}
```

Remove that temporary integration after capturing. In the same extension/page context,
run `stopSakuttoCaptionTrace()`, serialize the returned object, and save it as
`traces/local.json`. Replay it with the command above. Never commit the capture or add it
to the synthetic fixtures. The recorder helper itself is not included in any production
entry point.
