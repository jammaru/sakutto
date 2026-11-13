# Local server backend (MLX / LM Studio)

Research and design for adding Apple Silicon MLX as a selectable translation backend
([#59](https://github.com/jammaru/sakutto/issues/59)), sharing one OpenAI-compatible localhost
path with LM Studio ([#56](https://github.com/jammaru/sakutto/issues/56)).

This note names no issue authors. Default remains the built-in wllama engine. The local-server
path is an **experimental opt-in** with **no accuracy guarantee**. A Mac evaluation found that
MLX 4bit, 8bit, and bf16 all produce mistranslations the built-in engine does not, including
some that reverse the meaning. The cause is quantization numerics, not the request: the
client still sends the same PFML3 prompt. MLX is not claimed to be faster. Linux CI cannot
run MLX, and Mac timings are not product copy.

## Recommendation

Ship **one experimental "local server" engine** that talks to any OpenAI-compatible HTTP server
on the user's machine over `http://127.0.0.1` / `http://localhost`. Document two presets:

| Preset        | Default base URL           | Typical process                                                     |
| ------------- | -------------------------- | ------------------------------------------------------------------- |
| mlx_lm.server | `http://127.0.0.1:8080/v1` | `mlx_lm.server` from [mlx-lm](https://github.com/ml-explore/mlx-lm) |
| LM Studio     | `http://127.0.0.1:1234/v1` | LM Studio local server, including its MLX engine                    |

PLaMo 3 Translate's own bundled `serve.py` binds `127.0.0.1:8000` and is the vendor recipe
for MLX-4bit weights. The options field is a free URL, so that recipe is a documented
override, not a third in-product preset.

Translation requests use **raw `POST /v1/completions`** with the same PFML3 string the
built-in engine sends to wllama, `temperature: 0`, and the same stop tokens. Chat
completions are not used for PLaMo: a chat template would change the prompt.

Native Messaging and an in-extension MLX build are rejected for this iteration (see
[Integration paths](#integration-paths)).

## Why MLX cannot run inside the extension

[MLX](https://github.com/ml-explore/mlx) is Apple's array framework for Apple Silicon. The
language-model runtime used with PLaMo's MLX-4bit weights is
[mlx-lm](https://github.com/ml-explore/mlx-lm): native Python (and, separately, Swift)
loading Metal kernels. It is not a WASM module, not a WebGPU shader graph, and not
something a Manifest V3 content script or offscreen document can instantiate.

Chrome and Firefox extension pages may load WASM (`wasm-unsafe-eval` is already in
Sakutto's CSP) and WebGPU. They cannot:

- `dlopen` a `.dylib` or start a Python interpreter
- ship a notarized helper inside the `.crx` / `.xpi` that the browser will launch
- talk to Metal except through WebGPU (Dawn) or a native process

So "add MLX as a backend" for a store-distributed extension means **a process the user
already runs**, reached from the extension.

## Integration paths

### (a) Local OpenAI-compatible HTTP server — recommended

The extension already runs translation in an offscreen document (Chrome) or an engine
iframe (Firefox). Those contexts can `fetch()` a localhost URL once the user has granted
the matching **optional** host permission.

Servers that already speak this dialect:

- `mlx_lm.server` — [SERVER.md](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md):
  `POST /v1/chat/completions`, `POST /v1/completions`, `GET /v1/models`, `GET /health`.
  Default bind is `127.0.0.1:8080`. Temperature defaults to `0.0`. Stop sequences are
  honoured. The server is documented as not production-hardened (basic checks only, no
  API key of its own).
- PLaMo 3 Translate MLX `serve.py` — vendor wrapper around mlx-lm, default
  `127.0.0.1:8000`, `--trust-remote-code`, plus a 32,768-token pre-check. The model card
  tells integrators to send **hand-written PFML3 to Completions**, not Chat Completions,
  for production. mlx-lm prepends `<|plamo:bos|>`; the handwritten prompt must omit it.
  That matches Sakutto today: wllama/llama.cpp also prepends BOS, and
  `buildTranslationPrompt` omits it.
- [LM Studio](https://lmstudio.ai/) — OpenAI-compatible server at
  `http://localhost:1234/v1` by default, with an MLX engine on Apple Silicon. CORS can be
  enabled in LM Studio; with extension host permissions it is usually unnecessary.

**Install burden:** the user installs Python + mlx-lm (or LM Studio's GUI), downloads a
PLaMo MLX-4bit repo from Hugging Face, and starts a server. Heavier than "click Download
in the extension", but it is the same burden people who already use LM Studio or mlx-lm
have accepted. Sakutto does not bundle weights or a native helper.

**Security:** page text leaves the extension process and enters whatever bound that URL.
Default allow-list is loopback only. A non-loopback URL requires an explicit "send text
off this machine" confirmation and still only talks to the origin the user typed. Optional
host permission is requested at enable-time, not at install. The developer never sees the
text.

**CWS / AMO:** optional host permissions for `http://localhost/*` /
`http://127.0.0.1/*` (and a user-typed origin) are the documented MV3 pattern
([Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions),
[Match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)).
Sakutto already declares `optional_host_permissions: ["https://*/*", "http://*/*"]` for
per-site auto-translate; this feature requests a **subset** origin at runtime, the same
`permissions.request` path. Review notes should mention the new data path (text → the
user's server) without claiming a new install-time host permission.

**Private Network Access / Local Network Access:** Chromium's
[LNA](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)
gates public-site access to loopback. Chrome's current position is that **LNA is not
applied to extensions** that already have host permissions
([WICG/local-network-access#115](https://github.com/WICG/local-network-access/issues/115)).
PNA preflights (`Access-Control-Request-Private-Network`) are deprecated and are not
relied on. CORS: extension pages with host permission bypass CORS in Chrome and Firefox;
users of a misbehaving server can still turn on that server's "Enable CORS" toggle.

**Firefox:** same `fetch` + optional host permission. Native Messaging is _not_ required.
Firefox extension pages are not `crossOriginIsolated`, which already forces in-browser
CPU to one thread; the local-server path does not need SAB/wasm threads, so Firefox
parity is actually better here than for WebGPU.

**Maintenance:** one HTTP client, no pinned Python, no notarized helper, no per-OS
installer. Server bugs belong to mlx-lm / LM Studio. Sakutto owns prompt identity,
sampling, stop handling, permission UX, and docs.

### (b) Native Messaging host bundling an MLX runner — rejected for v1

[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
and [Firefox native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
can start a local binary over stdio. The store package still cannot contain that binary:
the user (or a `.pkg`) must register a host manifest under
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (and a separate
Firefox path with `allowed_extensions` instead of `allowed_origins`).

Costs:

- A shipped `nativeMessaging` permission, extra CWS/AMO review surface, and two host
  manifests (Chrome vs Firefox).
- Notarization / Gatekeeper for a Mac helper that embeds Python or links MLX.
- Update trains for mlx-lm, Metal, and the helper, decoupled from the extension version.
- No help for Windows/Linux users who wanted LM Studio anyway.

A host that _only_ reverse-proxied to `mlx_lm.server` would duplicate path (a) with more
install steps. Not worth it until path (a) is proven too constrained (for example if LNA
is later applied to extensions and localhost `fetch` is blocked).

### (c) Other credible paths

**In-page WebGPU already uses Metal on Mac.** Chromium's Dawn maps WebGPU to Metal.
Sakutto's built-in engine is llama.cpp via wllama, with the ggml WebGPU backend. On an
Apple GPU that is already Metal, plus WASM, JS marshalling, browser process limits, and
the Q4_K_M GGUF Sakutto pins (0.8B / 2B).

What MLX can add, without a speed claim:

- Native process, unified memory, no WASM / no WebGPU validation layer.
- Official **MLX-4bit** weights for 0.8B, 2B, **8B, and 31B** — sizes the browser engine
  does not ship. 8B/31B are the practical reason to opt in even if 0.8B were similar.
- PFN's own tables (see [Quantization](#quantization-versus-the-built-in-gguf)) show MLX
  4bit vs BF16 deltas in the same ballpark as GGUF Q4_K_M, not a free quality upgrade.
- Speculative decoding / KV-cache options in mlx-lm that wllama in the extension does not
  expose.

**WebGPU "MLX in the browser"** does not exist. mlx-lm is not compiled to WASM.

**Safari App Extension / native app** would reach MLX directly and is a different product.

## PLaMo 3 Translate MLX models

Collection: <https://huggingface.co/collections/pfnet/plamo-3-translate>

Published MLX weights (all **MLX-4bit** only; there is no BF16 MLX repo in the
collection):

| Size | Repo                                    | Approx. weight size |
| ---- | --------------------------------------- | ------------------- |
| 0.8B | `pfnet/plamo-3-translate-0.8b-MLX-4bit` | 0.98 GB             |
| 2B   | `pfnet/plamo-3-translate-2b-MLX-4bit`   | 2.41 GB             |
| 8B   | `pfnet/plamo-3-translate-8b-MLX-4bit`   | 6.07 GB             |
| 31B  | `pfnet/plamo-3-translate-31b-MLX-4bit`  | 18.66 GB            |

Other formats in the same collection (BF16, FP8, W4A16, W4AFP8, NVFP4, GGUF) target
Transformers / vLLM / llama.cpp, not mlx-lm.

**License:** PLaMo Community License on every card. Personal / academic use is free;
commercial use has PFN's published conditions. Sakutto already surfaces that license for
the GGUF path; a local MLX file is the same family. Other models the user loads in LM
Studio are the user's licence responsibility (noted in the options copy).

**mlx-lm architecture support:** the cards say the MLX build runs on mlx-lm with
`trust_remote_code=True` (custom tokenizer / model code in the repo). `requirements-mlx.txt`
in the 0.8B MLX repo lists unpinned `mlx-lm`, `mlx`, `transformers`, `numba`. PLaMo 3
landed in mlx-lm as architecture `plamo3` (see mlx-lm history around
[ml-explore/mlx-lm#1234](https://github.com/ml-explore/mlx-lm/pull/1234) and follow-ups).
**Install from the model repo's `requirements-mlx.txt`**, not an arbitrary old mlx-lm.
This Linux environment did not execute those packages.

Vendor guidance that Sakutto must follow
([0.8B MLX card](https://huggingface.co/pfnet/plamo-3-translate-0.8b-MLX-4bit)):

> For production use … we recommend building the prompt directly in the PFML3 format and
> passing it to the Completions API of the server.
>
> The mlx-lm server adds [`<|plamo:bos|>`] automatically, so do not add it to the
> beginning of a handwritten prompt.

Chat Completions + `chat_template_kwargs` is a convenience path. LM Studio may not
forward `chat_template_kwargs`. A generic chat template would wrap PFML3 in role markers
and mistranslate. **Sakutto always uses `/v1/completions` with the handwritten prompt.**

## Exact prompt Sakutto sends today

`src/engine/prompt/pfml3.ts` `buildTranslationPrompt`:

```
<|plamo:tag|>dataset<|plamo:msg|>translation
  [optional <|plamo:tag|>context<|plamo:msg|>…]
  [optional <|plamo:tag|>glossary<|plamo:index|>src<|plamo:item|>tgt …]
<|plamo:tag|>input
  [optional <|plamo:key|>lang<|plamo:val|>src]
<|plamo:msg|>TEXT
<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>tgt
  [optional <|plamo:key|>form<|plamo:val|>polite|plain  — ja only]
<|plamo:msg|>
```

No BOS. Stop tokens: `<|plamo:tag|>`, `<|plamo:bos|>`. wllama completion:

- `temperature: 0`
- `stop: TRANSLATION_STOP_TOKENS`
- `max_tokens: min(completionTokenBudget(text), contextTokens - estimateTokens(prompt) - 8)`
- stream on, `cache_prompt` only when `nParallel === 1`

The local-server runtime must send **that same prompt string** as `prompt`, the same
`temperature`, `stop`, and `max_tokens` rule. Output is passed through `cleanModelOutput`.
The in-browser planner (sentence splits, 2048-token context budget) is reused so a long
page is cut the same way. A larger MLX context window is **not** used for the 1.x client:
changing piece boundaries would change translations even with a matching model.

### Sampling and stop handling

| Knob                | Built-in                    | Local server                                                                                                                                                                                               |
| ------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt              | `buildTranslationPrompt`    | identical function                                                                                                                                                                                         |
| BOS                 | llama.cpp prepends          | mlx-lm prepends (vendor: do not add)                                                                                                                                                                       |
| temperature         | `0`                         | `0` (explicit; some servers default 0.7 if omitted)                                                                                                                                                        |
| top_p / penalties   | not sent                    | not sent (mlx-lm defaults are already greedy)                                                                                                                                                              |
| stop                | PFML3 tag + BOS             | same array                                                                                                                                                                                                 |
| stream              | yes                         | yes (`text/event-stream` only); JSON if that type is absent                                                                                                                                                |
| extra chat template | none                        | none — Completions only                                                                                                                                                                                    |
| finish              | wllama stops on stop tokens | `choices[0].finish_reason` must be `stop`. A cut-off SSE body, `[DONE]` without stop, `length`, `content_filter`, or malformed JSON is `EngineError`. Nothing is cached; the page keeps the original text. |

A 404 is **not** always "no Completions API". mlx-lm returns 404 on generation exceptions,
and LM Studio can 404 for an unloaded model. The client reads the body: a missing-route
shape (`Not Found`, empty 404) is Completions missing; `model not loaded` is
`server-model-missing`; anything else is `server-failed`. A URL that is not this computer,
and whose warning checkbox is still off, is `server-remote-unconfirmed` before any request
is sent. Chat completions are never used.

The AbortController deadline covers the SSE/JSON body, not only the response headers.

In LM Studio, set the server-side sampler to temperature 0 / greedy. Prompt parity is
measured against `mlx_lm.server` and PLaMo's `serve.py`. LM Studio's BOS handling is
unverified. Speed is not claimed.

### Quantization versus the built-in GGUF

Byte-identical **prompts** do not imply byte-identical **translations**.

Sakutto's in-extension files are GGUF **Q4_K_M** (0.8B and 2B). Official MLX weights are
a different 4-bit codec. PFN's cards compare each format to BF16 of the same size
(PFTB En↔Ja, SaaS En→Ja, WMT24++ COMET-22, FLORES+ chrF++). Selected 0.8B row:

| Format      | PFTB (En↔Ja) vs BF16 |
| ----------- | -------------------- |
| GGUF Q4_K_M | −0.0030              |
| MLX 4bit    | −0.0089              |

2B MLX 4bit is closer to BF16 (−0.0021 PFTB) than 0.8B MLX 4bit. 8B/31B MLX 4bit deltas
are small on those tables. **None of this is a speed claim.** The equality bench
(`scripts/bench/translation-equality.ts`) reports string differences on a fixed sentence
set; a difference is expected across codecs and is not treated as a client bug unless
the **request prompt** also differs.

On an Apple M4 Mac (Chromium 158 headless, mlx-lm 0.32.2,
`pfnet/plamo-3-translate-0.8b-MLX-4bit`, client at 53f594d) MLX-4bit output differed
textually from the built-in GGUF Q4_K_M on about **119 of 262** blocks. A later Mac
evaluation of MLX 4bit, 8bit, and bf16 found mistranslations the built-in engine does
not produce, including some that reverse the meaning. The cause is quantization
numerics, not the request. The local-server path is therefore experimental and does
not guarantee accuracy. That finding is a quality observation, not a speed claim.

Also observed on that Mac (fixed in this client; not re-measured here):

- Chrome offscreen has no `chrome.storage` (`typeof chrome.storage === 'undefined'`), so
  `engineSource` stayed `in-browser` until the service worker pushed `source-set`.
- `mlx_lm.server` 0.32.2 `/v1/models` can return an empty list. The connection test
  still probes `/v1/completions` and keeps a typed model name.
- Page in-flight of 2 plus WebGPU wave scheduling starved HTTP concurrency. Local-server
  now uses a non-wave scheduler and a configurable HTTP parallel limit.

LM Studio may apply its own repeat-penalty / sampler UI on top of the HTTP body. The
docs tell the user to set greedy / temperature 0 in the server app as well.

## Product design (shared with #56)

- Setting `engineSource`: `in-browser` (default) \| `local-server` (experimental, no accuracy guarantee).
- The first switch to the local server asks for confirmation. `localServerExperimentalAck` remembers that choice.
- Local-server fields: `localServerUrl`, `localServerModel`, `localServerApiKey`,
  `localServerTimeoutMs` (default 120s), `localServerAllowRemote` (default false),
  `localServerParallel` (default 8, range 1–16).
- Chrome's offscreen document has no `chrome.storage`. The service worker reads settings and
  pushes `engineSource` plus the local-server config with `source-set` (same pattern as
  `tier-set`). Firefox's event-page iframe of `offscreen.html` uses that same message path.
- Presets only fill the URL; they are not a stored enum.
- Chrome Translator remains the only engine for pairs PLaMo cannot do. No cross-engine
  fallback. A server failure keeps the source text.
- Cache key uses `local:<model-id>` so GGUF hits are not reused for MLX output.
- Glossary, bilingual display, selection translation, typed-text, compose: same
  `Engine.translate` path, so they keep working.
- Host permission requested when the user enables the backend or changes the origin.
  Only the configured URL's host origin is requested (for the default, `http://127.0.0.1/*`).
- Non-loopback URL: blocked until `localServerAllowRemote` is confirmed. The connection
  test says the checkbox is required (`server-remote-unconfirmed`) instead of a generic
  failure. Warning copy states that page text will leave this machine.
- Errors: original text stays; status / typed / selection surfaces name unreachable,
  missing model, or timeout, and point at Settings.
- Privacy: text goes to the user-configured server only; the developer does not receive
  it. README / PRIVACY.md describe that optional path.

## What this environment verified

Verified here (Linux VM, no Apple GPU, no MLX):

- Source of Sakutto's PFML3 builder, wllama completion parameters, routing, cache, and
  permission patterns.
- Public model cards, mlx-lm SERVER.md, PFN format tables, Chrome/Firefox permission and
  LNA documentation.
- Unit tests against a mocked OpenAI-compatible server, including prompt equality with
  `buildTranslationPrompt`.
- Options UI, i18n catalogs, Chrome and Firefox builds' typecheck/lint/tests.

Not verified here:

- LM Studio MLX engine and its BOS handling.
- Whether a future Chromium build applies LNA to extensions.

A Mac quality check (see above) found textual differences versus GGUF Q4_K_M. Speed
numbers from that machine are not quoted as product copy.

### Mac page timings (not product copy)

Recorded on Apple M4, headless Chromium 158, mlx-lm 0.32.2,
`pfnet/plamo-3-translate-0.8b-MLX-4bit`, client at f97ab19. Medians of a 3-run
`long-article` live bench. The 0.8B MLX-4bit weights are about 0.98 GB; mlx_lm.server
shares them across in-flight completions, so parallel 8 is the default. Lower it if a
larger model runs out of memory.

| Engine                   | firstVisibleTextMs | viewportMs | fullPageMs |
| ------------------------ | -----------------: | ---------: | ---------: |
| Built-in WebGPU          |             0.93 s |     4.08 s |     15.3 s |
| mlx_lm.server parallel 4 |             0.32 s |     5.95 s |     10.1 s |
| mlx_lm.server parallel 8 |             0.53 s |     2.53 s |      8.6 s |

Parallel 8 was faster than 4 on viewport and full page. First-visible was a little
slower (0.53 s vs 0.32 s). That is why 8 is the starting point, not a claim that MLX
is always faster than WebGPU.

Maintainer steps for those measurements: [bench/README.md](../../bench/README.md) (local
server section) and `scripts/bench/translation-equality.ts`.

## Sources

- <https://huggingface.co/collections/pfnet/plamo-3-translate>
- <https://huggingface.co/pfnet/plamo-3-translate-0.8b-MLX-4bit>
- <https://www.preferred.jp/en/blog/tech/plamo-3-translate-weight-release>
- <https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md>
- <https://github.com/ml-explore/mlx-lm/pull/1234>
- <https://github.com/ml-explore/mlx-examples/pull/489> (`/v1/completions` on the MLX server)
- <https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>
- <https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns>
- <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- <https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access>
- <https://github.com/WICG/local-network-access/issues/115>
- <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging>
