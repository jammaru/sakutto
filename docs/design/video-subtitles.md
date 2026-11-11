# Video subtitle translation

Research and design for translating captions with Sakutto's on-device PLaMo engine, in
real time. This note names no issue authors. Phase 1 (this tree) is a **research document
plus a minimal prototype** behind a setting. Nothing here is a speed claim in product copy.

The prototype does **not** add an external translation server. Caption text stays on the
device, on the same engine queue as page translation.

## Recommendation

**v1 (headline of the next release: real-time captions, behind an off-by-default setting):**

| Include                                                                                    | Skip                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| YouTube on-demand (player-embedded timedtext GET + prefetch)                               | InnerTube POST / inventing a player client           |
| YouTube Live as a first-class path (`.ytp-caption-segment` + recent ASR timedtext)         | On-device speech recognition (Whisper / tab audio)   |
| Dedicated X adapter (`video.twimg.com/subtitles/*.vtt` / `textTracks`, playing video only) | Fake captions when a video has none                  |
| Auto-run on youtube.com and x.com when the setting is on, via optional host permission     | New required host permissions, `tabCapture`          |
| Overlay on the player, bilingual by default, original immediately then translation         | Firefox as a shipping target in this phase           |
| Degenerate-output reuse: keep the original line; never cache garbage                       | Merging finished caption lines into a false sentence |

Captions already exist as text, so the model only has to translate. On-demand video can be
translated _ahead_ of the playhead. Live cannot prefetch far; it shows the original now and
replaces it when the translation lands. X stays silent when there is no VTT / textTrack.

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
   the player paints. Auto-captions grow word by word in that node. On live this is the
   first-class current line; rolling ASR timedtext is the backup when the DOM is empty.

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

Live captions are not a stable VTT file. v1 treats them as first-class:

- Growing `.ytp-caption-segment` text (word by word) is the current line.
- ASR timedtext covers only recent time (`selectLiveCaptionTrack` prefers ASR that is not
  already the target). The session refreshes that window about every 2.5 s; it is not a VOD
  track.
- In some streams, XML `<timedtext>` payloads inside media segments
  ([youtube-transcript-api#98](https://github.com/jdepoix/youtube-transcript-api/issues/98),
  [yt-dlp#2039](https://github.com/yt-dlp/yt-dlp/issues/2039)). v1 does not parse media
  segments.

`LiveCaptionBuffer` waits for a sentence terminator, a pause (`LIVE_CAPTION_MAX_WAIT_MS` =
1.2 s), or `LIVE_CAPTION_MAX_CHARS` (96), then translates the committed line. Growing
fragments stay on screen as original text and are not sent to the model. When a translation
is ready it replaces that line. Live jobs use priority `2` with `eager` and `preempt`, so a
page-translation batch can be cancelled to keep live latency low.

### X (Twitter)

Dedicated adapter (`src/captions/x.ts`). Some X videos ship WebVTT from
`video.twimg.com/subtitles/…`
([TwitterMediaHarvest#336](https://github.com/EltonChou/TwitterMediaHarvest/issues/336)).

- Discover: HTML5 `textTracks` on the playing video, then `<track src>` URLs that match
  `https://video.twimg.com/subtitles/*.vtt`.
- Player surfaces: timeline, post detail, fullscreen. `pickPlayingXVideo` prefers
  fullscreen, then an audible player, then the largest visible playing video. Idle feed
  neighbours are ignored.
- No captions → show nothing. No speech recognition.
- Fetch: same MAIN-world GET as YouTube timedtext, allowlisted to twimg VTT **only when
  the tab host is X**. This uses the page's CORS, not an extension host permission for
  `video.twimg.com`. If the GET fails, the overlay stays empty.

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
  `~10`) with `preempt: true`, so a running page batch is cancelled and the live line can
  start. Prefetch uses `24` (after nearby prose `~22`, before far chrome `~34`). Cancel on
  seek. Captions do not take the selection slot.

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
- The feature is off until the reader turns **Translate video captions** on in Settings
  (default OFF). Turning it on requests the existing optional host permission for
  youtube.com / x.com (and twitter.com aliases). Once granted, those tabs auto-run caption
  translation without pressing Translate. Other sites still need a user action or
  always-translate. There is no install-time YouTube or X host permission.

## Phased plan

| Phase            | Contents                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **v1 (this PR)** | Setting (default off) + overlay + bilingual. YouTube on-demand timedtext + prefetch. YouTube Live DOM buffer + recent ASR timedtext, original-then-translation, live preemption. X adapter (playing video, VTT/textTracks, silent if none). Auto-run on youtube.com / x.com via optional host permission. Degenerate-output reuse. Synthetic fixtures. |
| **Later**        | Speech recognition only with a separate opt-in, Chrome `tabCapture` justification, and a second on-device model. Firefox ship decision. Media-segment live XML.                                                                                                                                                                                        |

## Permissions and store review

**v1 requests no new permissions.** Release manifest stays:

`offscreen`, `storage`, `unlimitedStorage`, `activeTab`, `scripting`, `contextMenus`

Optional host permissions stay `https://*/*` and `http://*/*`. They are requested for
always-translate, a local server, **or** when the reader turns caption translation on
(youtube.com / x.com / twitter.com page origins only). `video.twimg.com` is not requested.

Same-origin `fetch` of a YouTube `timedtext` `baseUrl` does not need an extra host
permission. Isolated-world `fetch` is the extension origin, so the GET runs in the page
world through the existing `scripting` permission (`world: 'MAIN'`), only for a URL that
shares the tab origin, after a user gesture (or after always-translate was granted for
that host).

### Justification text (store review, when this ships)

```text
Sakutto translates web pages on the device. An optional setting also translates captions
already present on a video the user is watching (YouTube including live, X when a VTT
track is published, and HTML5 subtitle tracks). Caption text is read from the page the
user opened and translated by the same on-device model as page text. It is not sent to
the developer or to a third-party translation server. The extension does not capture tab
audio. When the setting is turned on, Chrome asks for access to YouTube and X using the
same optional host permission as always-translate; those sites then auto-run caption
translation. Videos with no captions are left alone.
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
| Engine contention with page translation          | Caption live priority 2 + preempt, prefetch 24, abort on seek                                                                    |
| Overlay vs YouTube controls / fullscreen         | Closed shadow, `pointer-events: none` except the bilingual toggle, reparent on fullscreen                                        |
| HTML5 / twimg CORS-empty cues                    | Show nothing; do not add a twimg host permission                                                                                 |
| Firefox                                          | TextTrack and script-tag parse work; `tabCapture` does not. Not a shipping target in this phase                                  |

## Test plan

- **Unit:** WebVTT and json3 parsers; word-cue merge (no false sentences); live buffer;
  player-response / live track choice; X playing-video picker and twimg allowlist;
  auto-inject gating; popup/options toggle permission-denied revert; overlay bilingual/replace;
  translator cache, seek cancel, degenerate skip, live preempt; scheduler preemption;
  session live original-then-translation, setting-off overlay removal, and silent X.
- **e2e:** HTML5 dummy clip; YouTube on-demand; YouTube live auto-run without Translate;
  X-like DOM + VTT (playing video only); X with no captions → nothing; popup switch
  on/off propagation and permission-denied revert. No real people, no personal info, no
  copyrighted footage. Fake engine marker `§en§`. Setting off → no overlay.
- Fixtures are served by `e2e/serve.mjs` with `text/vtt` and `video/mp4` types.

## Firefox

Not required to ship in this phase. Expected to work for HTML5 `textTracks` and for YouTube
script-tag + same-origin timedtext once the content script is injected. Engine host is the
existing hidden iframe, not `offscreen`. CPU is single-thread without COOP/COEP, so live
captions will lag unless WebGPU is up. No `tabCapture` later either.

## Prototype in this tree

- Settings: `translateVideoCaptions` (default false), `videoCaptionDisplay` (default
  `bilingual`). The popup has one compact switch for the same setting; Options stays the
  detailed page. Turning the switch on asks for optional YouTube/X host access in that
  click. A denial reverts the switch and shows a one-line hint. Open tabs pick the change
  up live (off removes the overlay; on starts on the current YouTube/X video without a
  reload when the content script can inject).
- Content script starts `VideoCaptionSession` when the setting is on and the site is not
  `never`.
- Modules: `src/captions/` (`cues.ts`, `youtube.ts`, `html5.ts`, `x.ts`, `sites.ts`,
  `engine.ts`, `overlay.ts`, `session.ts`, `timedtext.ts`). Named `captions` rather than
  `video` so git does not ignore the tree (`video/` is in `.gitignore` for local clips).

## Open questions (remaining)

1. **Shortcut:** the popup now has the on/off switch. A dedicated keyboard command is still
   open if shipping v1 wants one besides the setting.
2. **Default display vs page display:** bilingual stays the caption default. Should shipping
   v1 follow the page-translation display setting instead?
3. **twimg CORS:** if X attaches no `textTrack` and the page-world GET is blocked, v1 shows
   nothing. Is that the right product answer, or should a later phase ask for a twimg
   origin (still optional, still not v1)?
4. **music.youtube.com / youtube-nocookie:** auto-run requests those origins with the
   setting. Trim the prompt to www.youtube.com + x.com only?

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
