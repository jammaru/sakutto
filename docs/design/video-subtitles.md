# Video subtitle translation

Research and design for translating captions with Sakutto's on-device PLaMo engine, in
real time. This note names no issue authors. Phase 1 (this tree) is a **research document
plus a minimal prototype** behind a setting. Nothing here is a speed claim in product copy.

The prototype does **not** add an external translation server. Caption text stays on the
device, on the same engine queue as page translation.

## Recommendation

**v1 (this prototype, behind an off-by-default setting):**

| Include                                                                                                   | Skip                                                     |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| On-demand YouTube videos that already have a caption track, using the full timedtext payload and prefetch | YouTube live / real-time ASR as a primary path           |
| Generic HTML5 `<video>` `textTracks` (WebVTT)                                                             | X as a dedicated adapter                                 |
| Overlay on the player, bilingual by default, fullscreen-aware                                             | On-device speech recognition (Whisper / tab audio)       |
| Degenerate-output reuse: keep the original line rather than paint garbage                                 | New host permissions, `tabCapture`, or `getDisplayMedia` |

This is the highest-value slice that is also the most robust: the captions already exist as
text, so the model only has to translate, and on-demand video can be translated _ahead_ of
the playhead. Live streams, X, and captionless video are later phases.

## Per-platform approach

### YouTube on-demand

YouTube exposes captions in three layers. v1 uses (1) and (2); (3) is the live fallback.

1. **Caption track list in the player response.** The watch page HTML contains
   `ytInitialPlayerResponse`. Under
   `captions.playerCaptionsTracklistRenderer.captionTracks[]` each track has `baseUrl`,
   `languageCode`, `kind` (`"asr"` = auto-generated), `name`, and `vssId`.
   Sources: [InnerTube captionTracks](https://github.com/tombulled/innertube/issues/57),
   [ytranscript notes](https://www.nadimtuhin.com/blog/ytranscript-how-it-works),
   [DisTube captions guide](https://distube.js.org/ytdl-core/guides/captions/).

2. **`/api/timedtext`.** Fetch `{baseUrl}` and **replace** (do not append) `fmt`:
   - `fmt=json3` — `{ events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }`
   - `fmt=vtt` — WebVTT
     Appending a second `fmt` leaves `srv3` in place and YouTube returns XML
     ([invidious#4221](https://github.com/iv-org/invidious/pull/4221)).

   The prototype reads `baseUrl` **from the page that is already loaded**. It does not POST
   to `youtubei/v1/player` and does not invent an InnerTube client. Isolated-world `fetch`
   is the extension origin, so YouTube will not CORS it. The GET therefore runs in the
   page world (`scripting.executeScript`, `world: 'MAIN'`), same-origin with the watch tab
   (cookies and the `pot=` proof-of-origin parameter that YouTube started attaching around
   August 2024 travel with the URL the player already used). The background only accepts a
   URL that shares the tab's origin. A missing `pot` often yields HTTP 200 with an empty
   body
   ([yt research notes](https://github.com/zemse/yt/blob/fd92fb17c6693d677038c8e329e4daf3ccaaf69a/RESEARCH.md)).

3. **Caption DOM.** `.ytp-caption-segment` inside `.ytp-caption-window-container` is what
   the player paints. Auto-captions grow word by word in that node. The prototype observes
   it only when a full track cannot be fetched (live / empty timedtext).

The content script runs in the isolated world, so `window.ytInitialPlayerResponse` is not
visible and also goes stale on SPA navigation. Script-tag text is parsed instead.
`yt-navigate-finish` reloads the track.

**Track choice:** a human-written track whose language is not the translation target, then
any manual track, then ASR. A track that is already in the target language is shown as-is.

**ToS / fragility.** YouTube's terms restrict automated access and downloading of content.
Reading a caption URL the player itself embedded on a page the user opened, then
translating on-device, is the least invasive option. Scraping InnerTube from a background
worker, or batch-downloading timedtext off the watch page, is not v1. The JSON shape and
the `pot=` parameter change without notice; DOM class names (`.ytp-caption-segment`) also
change. Tests therefore use **local fixtures**, not live youtube.com.

### YouTube live

Live captions are not a stable VTT file. They show up as:

- Growing `.ytp-caption-segment` text (word by word).
- ASR timedtext that only covers recent time, not the future.
- In some streams, XML `<timedtext>` payloads inside media segments
  ([youtube-transcript-api#98](https://github.com/jdepoix/youtube-transcript-api/issues/98),
  [yt-dlp#2039](https://github.com/yt-dlp/yt-dlp/issues/2039)).

v1 does not parse media segments. The live DOM buffer (`LiveCaptionBuffer`) is implemented
and unit-tested so a later phase can turn it on without inventing a new pipeline: wait for
a sentence / pause / character cap, then translate. That path cannot prefetch.

### X (Twitter)

Some X videos ship WebVTT from `video.twimg.com/subtitles/…`
([TwitterMediaHarvest#336](https://github.com/EltonChou/TwitterMediaHarvest/issues/336)).
When the player attaches that file as an HTML5 `textTrack`, the generic v1 adapter already
picks it up. Many videos have no captions at all. There is no public first-party subtitle
API, and the DOM player is an implementation detail. A dedicated X adapter is later:
discover VTT URLs (textTracks, then `video.twimg.com` responses already made by the page),
and only then consider speech recognition.

### Generic HTML5

Standard and the most robust path:

- `HTMLMediaElement.textTracks`
- `<track kind="subtitles|captions" src="…vtt">`
- `VTTCue` (`startTime`, `endTime`, `text`)
- `cuechange` / `cues` once `mode` is not `disabled`

A `disabled` track exposes no cues. v1 sets the chosen track to `hidden` so the browser
does not paint a second overlay, then paints Sakutto's overlay. Cross-origin VTT without
CORS yields empty cues; that is a platform limit, not something an extension should bypass
by fetching the VTT from the background with extra host permissions in v1.

Sources: [MDN textTracks](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/textTracks),
[MDN TextTrack](https://developer.mozilla.org/en-US/docs/Web/API/TextTrack).

## Videos without captions — speech recognition

Feasible later, **not v1**.

| Piece                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome `tabCapture` + offscreen `getUserMedia({ chromeMediaSource: 'tab' })` | Chrome-only. Needs a user gesture / `activeTab`. Capturing a tab silences it unless the stream is routed back to `AudioContext.destination`. `getDisplayMedia` is a picker, not silent tab audio. Firefox has no `tabCapture`.                                                                                                                                                                                                                    |
| Whisper via WebGPU / wasm                                                    | Extra model (tiny ~40–80 MB, base ~150 MB) next to PLaMo. Transformers.js / whisper.cpp-style builds exist. Measured speech-to-text latency on a fast Apple GPU is still ~1.5–2.2 s to a first caption after speech onset for Whisper `base` ([example extension write-up](https://github.com/xignoe/videoTranslatorExtenstion)); wasm on CPU is slower. Accuracy on mixed languages and proper nouns is a product risk this project cares about. |
| Chrome Speech Recognition API                                                | Sends audio to Google. Violates "everything stays on-device". Out of scope.                                                                                                                                                                                                                                                                                                                                                                       |

Size, RAM, and a second model download fight Sakutto's "one PLaMo, on the device" story.
Wrong transcriptions become wrong translations. v1 only translates captions that already
exist as text. Speech recognition is a later, explicit opt-in with its own consent and
store-permission justification.

## Latency budget

These numbers are **measured or derived from existing Sakutto benches**, not a new live
model run in this environment. They are conditions, not promises.

### Measured (repository benches)

**CPU wasm, no WebGPU**, HeadlessChrome, 4 threads, `plamo-3-translate-0.8b-q4_k_m`
(`bench/results/baseline.json`, 2026-11-05):

| Case                                     |       Wall |       TTFT | Output                     |
| ---------------------------------------- | ---------: | ---------: | -------------------------- |
| Short phrase, cache off                  |     980 ms |     802 ms | 5 tokens, ~22 tok/s decode |
| Short phrase, cache on                   | 356–368 ms | 170–194 ms | 5 tokens, ~22 tok/s        |
| Quality paragraph (~161 JP chars), first |  6.4–6.5 s |      2.6 s | 79 tokens, ~20 tok/s       |
| Quality paragraph, cached                |      3.9 s |     0.18 s | ~20 tok/s                  |

**WebGPU**, RTX 4070 Ti SUPER, Chromium 156, 8 threads, long-article fixture:

| Run                  | First visible | Full page | Blocks/s |
| -------------------- | ------------: | --------: | -------: |
| `webgpu-swa-full`    |         0.5 s |    14.6 s |      3.1 |
| `pr27-webgpu-review` |         0.3 s |     4.0 s |     11.6 |

Firefox on the same GPU (see `docs/FIREFOX.md`): WebGPU kick-on first sentence ~0.55–0.83 s;
CPU 1-thread first sentence ~2.7 s.

`HIGH_QUALITY_PARAGRAPH_MS` in product code is 1.5 s for a GPU-tier suggestion gate. That
is a paragraph, not a caption line.

### Estimate per caption line (0.8B)

A typical caption is 8–15 English words (~12–25 output tokens in Japanese).

| Runtime                                           |                        Uncached line | After a similar prompt (KV cache) | vs a 2–4 s cue                   |
| ------------------------------------------------- | -----------------------------------: | --------------------------------: | -------------------------------- |
| CPU wasm, 4 threads                               | ~0.9–1.7 s (prefill ~0.8 s + decode) |                        ~0.4–0.8 s | Borderline without prefetch      |
| WebGPU, discrete (same class as the page benches) |                           ~0.2–0.6 s |                             lower | Fits inside one cue              |
| Firefox CPU `c1`                                  |                         multi-second |                        still slow | Prefetch required; live will lag |

**Design that follows from the budget:**

- **On-demand:** translate the full track ahead of the playhead (`captionPrefetchWindowMs`:
  30 s on GPU, 12 s on `c8`, 6 s on smaller CPU tiers). Seeking aborts in-flight work and
  prefetches around the new time. Repeated lines hit an in-memory map; the engine's
  IndexedDB cache still applies underneath.
- **Live / ASR word-by-word:** do not send each word. `LiveCaptionBuffer` waits for a
  sentence terminator, a pause (`LIVE_CAPTION_MAX_WAIT_MS` = 1.2 s), or
  `LIVE_CAPTION_MAX_CHARS` (96). Auto-caption json3 events are merged the same way
  (`mergeWordCues`).
- **Queue:** live captions use priority `2` (after selection `0`, before visible page prose
  `~10`). Prefetch uses `24` (after nearby prose `~22`, before far chrome `~34`). Cancel on
  seek. Page translation keeps running; captions do not take the selection slot.

## UX

- Overlay (`<sakutto-captions>`, closed shadow root) sits on the player, not in page prose.
  `<video>` stays in the frozen selector so page translation does not rewrite the media
  subtree.
- **Bilingual is the default** (`videoCaptionDisplay`). Side-by-side is what people use to
  study and to check accuracy. Replace mode is a setting and a control on the overlay.
- While a line is in flight, **the original stays on screen**. A broken or
  `error: true` result is not cached and is not painted; `isBrokenTranslation` from
  `src/engine/text/degenerate.ts` is the gate.
- Native YouTube captions are hidden with a CSS rule on `.ytp-caption-window-container`
  while the overlay is active (fragile; documented). HTML5 tracks are set to `hidden`.
- Fullscreen: the host is re-parented into `document.fullscreenElement` when that node
  contains the video, then placed from `getBoundingClientRect()`. `position: fixed` plus
  capture-phase `resize` / `scroll` / `fullscreenchange`.
- The feature is off until the reader turns **Translate video captions** on in Settings.
  The content script still injects only after a user action (`activeTab` + `scripting`) or
  on a site already granted for always-translate. There is no install-time YouTube host
  permission.

## Phased plan

| Phase            | Contents                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1 (this PR)** | Setting + overlay + bilingual. YouTube on-demand via player-response timedtext and prefetch. Generic HTML5 `textTracks`. Degenerate-output reuse. Unit tests and e2e on synthetic VTT + a dummy colour video.               |
| **v1.x**         | YouTube live via the DOM buffer (and, if it stays stable, incremental timedtext). Hide/show native captions more reliably. Optional always-on for youtube.com through the existing optional host permission, not a new one. |
| **Later**        | Dedicated X adapter when a VTT URL is present. Speech recognition only with a separate opt-in, Chrome `tabCapture` justification, and a second on-device model. Firefox ship decision.                                      |

## Permissions and store review

**v1 requests no new permissions.** Release manifest stays:

`offscreen`, `storage`, `unlimitedStorage`, `activeTab`, `scripting`, `contextMenus`

Optional host permissions stay `https://*/*` and `http://*/*`, requested only for
always-translate or a local server, as today.

Same-origin `fetch` of a YouTube `timedtext` `baseUrl` does not need an extra host
permission. Isolated-world `fetch` is the extension origin, so the GET runs in the page
world through the existing `scripting` permission (`world: 'MAIN'`), only for a URL that
shares the tab origin, after a user gesture (or after always-translate was granted for
that host).

### Justification text (store review, when this ships)

```text
Sakutto translates web pages on the device. An optional setting also translates captions
already present on a video the user is watching (YouTube caption tracks, and HTML5
subtitle tracks). Caption text is read from the page the user opened and translated by
the same on-device model as page text. It is not sent to the developer or to a third-party
translation server. The extension does not capture tab audio and does not add host
permissions for this feature. The content script is still injected only after the user
asks to translate, or after they grant always-translate for that site.
```

Do not add `tabCapture`, `desktopCapture`, or `getDisplayMedia` without a new review pass
and a narrower justification. Single purpose remains translation of text the user is
already looking at.

## Risks

| Risk                                             | Mitigation                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| YouTube timedtext / `pot=` / player JSON changes | Parse defensively; fall back to HTML5 tracks and to `.ytp-caption-segment`; never call InnerTube from the extension worker in v1 |
| Empty timedtext body (bot / PO token)            | Treat as no track, keep original, do not retry in a loop                                                                         |
| ToS / "downloading captions"                     | Only fetch the `baseUrl` already on the watch page; no bulk harvest                                                              |
| Wrong translations                               | Bilingual default; original while pending; `isBrokenTranslation`; no cache on failure                                            |
| Engine contention with page translation          | Caption live priority 2, prefetch 24, abort on seek                                                                              |
| Overlay vs YouTube controls / fullscreen         | Closed shadow, `pointer-events: none` except the bilingual toggle, reparent on fullscreen                                        |
| HTML5 CORS-empty cues                            | Document; do not add host permissions to scrape the VTT in v1                                                                    |
| Firefox                                          | TextTrack and script-tag parse work; `tabCapture` does not. Prototype is Chrome-first                                            |

## Test plan

- **Unit:** WebVTT and json3 parsers; word-cue merge; live buffer; player-response and
  `fmt` replacement; overlay bilingual/replace; translator cache, seek cancel, degenerate
  skip; session paints from a mocked timedtext fetch.
- **e2e:** `e2e/fixtures/video-captions.html` (dummy H.264 colour clip + synthetic VTT) and
  `e2e/fixtures/youtube-captions.html` (synthetic `ytInitialPlayerResponse` + local json3).
  No real people, no personal info, no copyrighted footage. Fake engine marker `§en§`.
  Setting off → no overlay.
- Fixtures are served by `e2e/serve.mjs` with `text/vtt` and `video/mp4` types.

## Firefox

Not required to ship in this phase. Expected to work for HTML5 `textTracks` and for YouTube
script-tag + same-origin timedtext once the content script is injected. Engine host is the
existing hidden iframe, not `offscreen`. CPU is single-thread without COOP/COEP, so live
captions will lag unless WebGPU is up. No `tabCapture` later either.

## Prototype in this tree

- Settings: `translateVideoCaptions` (default false), `videoCaptionDisplay` (default
  `bilingual`).
- Content script starts `VideoCaptionSession` when the setting is on and the site is not
  `never`.
- Modules: `src/captions/` (`cues.ts`, `youtube.ts`, `html5.ts`, `engine.ts`, `overlay.ts`,
  `session.ts`, `timedtext.ts`). Named `captions` rather than `video` so git does not ignore
  the tree (`video/` is in `.gitignore` for local clips).

## Open questions for the maintainer

1. **Injection:** should caption translation start only after the reader invokes Translate
   on that tab (current, no new permission), or auto-inject on youtube.com when the setting
   is on (uses the existing optional host permission, one extra prompt)?
2. **timedtext vs DOM-only:** is fetching the player-provided `baseUrl` acceptable for
   store / ToS, or should v1 stay on `.ytp-caption-segment` + HTML5 tracks even if that
   kills prefetch?
3. **Default display:** bilingual is the prototype default because accuracy checking was
   requested. Should shipping v1 follow the page-translation display setting instead?
4. **Live in the same release:** the DOM buffer is already there. Worth enabling on YouTube
   live in v1, or keep it dark until prefetch has shipped and settled?
5. **Priority vs in-flight page batches:** live captions are priority 2, like a calmer
   selection. Should they preempt a streaming page batch the way selection does?
6. **Shortcut / popup control:** Settings-only for the prototype. A popup toggle or a key
   before shipping?
7. **Speech recognition:** confirm it stays out of v1 even as a hidden flag.
8. **Firefox:** ship HTML5 + YouTube when Chrome v1 lands, or wait for a live path that
   does not need `tabCapture`?

## Sources

- YouTube `captionTracks` / timedtext: InnerTube issue 57; ytranscript write-up; DisTube
  captions guide; invidious PR 4221 (`fmt` replace); zemse/yt `RESEARCH.md` (PO tokens).
- YouTube live: youtube-transcript-api issue 98; yt-dlp issue 2039.
- HTML5: MDN `textTracks`, `TextTrack`.
- X VTT: TwitterMediaHarvest issue 336 (`video.twimg.com/subtitles/…`).
- MV3 tab audio: Chrome `tabCapture.getMediaStreamId` + offscreen `getUserMedia`.
- Whisper-in-extension latency: public WebGPU/wasm figures cited above; not measured on
  Sakutto's machine in this run.
- Sakutto benches: `bench/results/baseline.json`, `bench/results/pages/pr27-webgpu-review.md`,
  `bench/results/pages/webgpu-swa-full.md`, `docs/FIREFOX.md`.
