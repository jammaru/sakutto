# Caption trace capture and replay

The caption replay harness exercises the real `VideoCaptionSession` with a fake DOM,
a virtual clock, and a deterministic fake translator. It does **not** download or scrape
YouTube, load a video, call a translation engine, or use the network. The player response
and ASR caption track are synthetic, and the track reader always returns an empty string.

Committed fixtures under `tests/fixtures/caption-traces/` are hand-written English and
Japanese word-by-word ASR snapshots. Their 1.5-second word spacing lets even the 900 ms fake
request finish; faster local traces are useful for probing cancellation. Do not put captured
captions or other real video data in that directory. Local captures belong in `traces/`,
which is gitignored.

## Replay

On the repository's supported Node 24+ runtime:

```sh
node scripts/caption-replay.ts
```

Node 22 can run the same script with its TypeScript transform flag:

```sh
node --experimental-transform-types --no-warnings scripts/caption-replay.ts
```

By default, both synthetic fixtures are replayed at 150, 400, and 900 ms translation
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

The tests require stable width and height, no blank translation after the first translated
frame, and at least 400 ms dwell for every distinct visible translation. They also check
that translations actually occurred so an empty replay cannot pass vacuously.

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
- **translation dwell:** duration of each run of the same non-empty visible translation,
  including short caption holds through silence. The minimum and median are calculated over
  those runs at 100 ms sampling resolution.
- **translation input lengths:** UTF-16 string lengths in request order.
- **cancellations:** in-flight fake translation requests whose abort signal fired.

The fake DOM gives live captions a fixed 576×72 px two-row rectangle. Leaving live layout
mode changes that rectangle, so session layout regressions remain observable without a
browser layout engine.

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
