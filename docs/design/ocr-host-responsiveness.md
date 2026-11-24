# Keeping the engine host responsive during OCR

## Problem

The shipped ONNX Runtime configuration runs WASM on the offscreen document's main
thread (`numThreads = 1`, `proxy = false`). A page recognition is a
sequence of detector/recognizer runs with no macrotask boundary, so for the whole
~34 s standard-tier page the document cannot process extension port messages.

The service worker's status polls (`engine:status`, `ocr-status`,
`ping`) had a 15 s / 2 s client bound. When that bound fired, the client
classified the timeout as an unavailable host, dropped the port and recreated the
offscreen document — which aborted the recognition that was still running.

## Chosen fix: yield in the OCR loop + never tear down a busy host

1. **Yield between WASM calls (option B).** `OcrPipeline` awaits a macrotask
   boundary before each text-box recognition (default `setTimeout(0)`,
   injectable as `yieldBetweenRuns` for tests). A microtask await is not
   enough: port messages arrive as tasks. The yield is between runs, so it does not
   split a single ONNX inference and does not change recognition output.
2. **A timeout is not a dead host (option C).** `EngineClient` now gives a
   timeout its own `HostTimeoutError` (still surfaced to callers with the
   public `offscreen-unavailable` code). While a recognition is in flight, a
   timeout neither drops the port nor recreates the offscreen document — in the
   request path or in the initial source/runtime/model push path. `ocr-status`
   uses the page bound while a recognition is active instead of racing it at 15 s.
   A genuine port disconnect still fails and cancels in-flight requests; that path
   is unchanged.

## Options considered and rejected

- **Option A (ORT `proxy: true`).** Moving inference to a worker would free the
  main thread, but it changes how WASM paths and model buffers resolve inside both
  Chrome MV3 and Firefox, needs a second copy of the models across a worker boundary,
  and can only be trusted after an end-to-end run with the real 15 MB runtime. It is
  a larger risk than the responsiveness bug warrants, and it offers no accuracy
  benefit. The proven single-threaded setup is kept.
- **Option C alone.** Not tearing down the host prevents the abort, but status polls
  would simply hang until the recognition finishes. The UI would still look stuck,
  and one slow WASM call longer than the poll bound would still be misread as a
  dead host. The yield makes the host genuinely responsive; the timeout guard is
  the safety net for that one long call.

## Invariants

- Recognition output is unchanged (same model, same preprocessing, same CTC decode),
  so the default-1600 scan CER and cross-column result must stay the same.
- The offscreen document is only recreated on a real disconnect/host-gone response
  when no recognition is pending, or on an explicit user action.
- Tests: `tests/ocr-postprocess.test.ts` checks a macrotask boundary between
  recognitions; `tests/engine-client.test.ts` checks that status/ping timeouts
  during OCR keep the port and that ocr-status waits past the old 15 s bound.
