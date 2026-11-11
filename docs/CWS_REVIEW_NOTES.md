# Chrome Web Store review notes

Reviewer-facing facts for the current tree. The source of truth for model pins is `src/engine/model/catalog.ts`. The release permission list is `wxt.config.ts`. Package checks are `scripts/verify-package.ts`. Onboarding copy is `public/_locales/en/messages.json` and `public/_locales/ja/messages.json`. Consent storage is `src/shared/settings.ts` and `src/entrypoints/onboarding/App.svelte`.

Repository: https://github.com/jammaru/sakutto

Privacy policy: https://jammaru.com/sakutto/privacy/

`PRIVACY.md` is the stable user-facing policy. It describes categories of data and who can see them, so it does not change when a constant, a file path, or a request header changes. This file is the opposite: it is the reviewer-facing implementation detail, and the hashes, byte sizes, character limits, storage names, and source paths below are expected to track the tree. When the two disagree about a fact, the code and this file win and `PRIVACY.md` should be re-read only to confirm it still describes the same categories.

The same privacy URL ends both detailed descriptions in `CWS_LISTING.md`. The listing is published at https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl.

The packaged name is `extensionName` in both locales: Sakutto - Local AI translation in `en` and Sakutto - ローカルAI翻訳 in `ja`. `extensionShortName` is Sakutto in both. Both the item name and the summary are read-only in the dashboard and come from the zip. The older titles Sakutto for PLaMo and サクッと翻訳 for PLaMo are not the current name. The item is unofficial and is not a Preferred Networks product. The UI says Built with PLaMo.

Paste the block below into the reviewer notes field. The same pins are repeated in Japanese afterwards so the owner can read them without the English block.

## Notes to paste

```text
Sakutto (https://github.com/jammaru/sakutto) translates web pages on the device. It is unofficial and is not affiliated with Preferred Networks. Built with PLaMo. The packaged name in _locales/en is Sakutto - Local AI translation and in _locales/ja it is Sakutto - ローカルAI翻訳; the short name is Sakutto in both. There is no account, no analytics, and no telemetry.

Single purpose: translating web pages.

Privacy policy: https://jammaru.com/sakutto/privacy/

Remote code: モデル重み（GGUF データ）のみを huggingface.co から DL。実行コードはすべて同梱。
The built-in engine's only fetch is a PLaMo 3 Translate GGUF weight from huggingface.co. The URL is pinned to a commit. Bytes are written to a `.part` file in the same OPFS directory, then read back and hashed against the pinned SHA-256; only a match is moved to its final name, and a mismatch is deleted and retried once from the start. An interrupted download keeps its `.part` file so the next attempt resumes. A later launch uses the stored file when its size and the recorded digest still match the pin. The bytes are not hashed again on every launch. The request has no body. Page text is not included. Hugging Face can see the IP address and the file request. Redirects are followed. credentials is omitted. Every script, worker, and wasm the extension executes is in the zip under vendor/wllama/. The extension does not request nativeMessaging.

Settings may enable an experimental local-server engine (mlx_lm.server, LM Studio, or any OpenAI-compatible process the user starts). Accuracy is not guaranteed. That path POSTs raw PFML3 to /v1/completions at the URL the user set. Default is loopback only (http://127.0.0.1:8080/v1). A non-loopback URL is blocked until the user confirms a warning. Optional host permission for that origin is requested only when the user turns the engine on or changes the address. Page text then goes only to that address. The developer does not receive it. Chat completions are not used.

Release manifest permissions: offscreen, storage, unlimitedStorage, activeTab, scripting, contextMenus. optional_host_permissions: https://*/* and http://*/*. host_permissions is empty at install. optional_permissions is empty. The content script is registered at runtime and injected with scripting.executeScript. It is not granted for every site at install.

Optional host permission is requested when automatic translation is turned on for one site, and when a local server is enabled. A site request is that host (https and http), from the popup or from the grant page during the click. Turning automatic translation off stores the site rule as ask. A local-server request is the loopback patterns or the hostname the user entered, from Settings. The code does not call permissions.remove.

Onboarding is one click on the agree-and-start button: Agree to the license and start (ライセンスに同意して開始). There is no consent checkbox. On Chromium the shared-folder option is first, labelled recommended, and preselected; the picker steps sit under it. Firefox and pages without `showDirectoryPicker` keep OPFS with no choice. The button stores, in chrome.storage.local, license plamo-community, version 2026-11-05, an ISO timestamp, and ageNoticeShown: true. ageNoticeShown records only that the notice was on screen for that click. It is not a verification of age or of a guardian's consent, and the page has no guardian control. The notice beside the button says: "Starting means you agree to the whole PLaMo Community License. You must be 18 or older, or have a parent or guardian's consent (Article 2). This extension does not check your age or ask a guardian to confirm." The same panel summarizes the Article 3 commercial conditions and links to the bundled license texts, the official pages, and PFN's registration form.

Stored on the device: settings, glossary, per-site rules, and that consent record in chrome.storage.local; a timing sample for a fixed paragraph (model id, duration, timestamp; not page text); a short capabilities cache in chrome.storage.session; the model file in the OPFS directory sakutto by default (`src/engine/model/file-store.ts`); optionally, on Chromium, a user-chosen folder via the File System Access API (`showDirectoryPicker` in the options page, `startIn: 'documents'`). The picker copy tells the user to create a folder named Sakutto in Documents (or open it) and select Documents\\Sakutto; Chromium blocks selecting Documents, Desktop, home, and Downloads themselves (`kDontBlockChildren` in `chrome_file_system_access_permission_context.cc`, see `docs/design/shared-model-folder.md`). The `FileSystemDirectoryHandle` is stored in IndexedDB database `sakutto-model-folder`. Official PFN filenames live under `<chosen>/sakutto-models/`. The offscreen document and service worker cannot show the picker or `requestPermission`; they call `queryPermission` and read the handle only when it is already `granted`. Bytes from the shared folder are hashed against the catalog pin on adopt and whenever size or lastModified changes (`src/engine/model/integrity.ts`). When a shared folder is set, each verified official model already in OPFS is streamed into `sakutto-models` as a `.part` file, checked for size and SHA-256, then renamed; a partial copy is discarded (`src/engine/model/copy.ts`). The OPFS file is deleted only after that verified copy. A failed or interrupted copy leaves OPFS in place. If folder permission is later lost, the existing permission-needed alert is shown and the model is not fetched again. Chrome can drop the directory grant when the picker page closes; see `docs/design/fsa-permission-lifetime.md`. No extra manifest permission is added. A translation cache in IndexedDB database sakutto-translations (at most 5000 rows). The cache key includes a SHA-256 of the source text and a hash of the glossary. The source text itself is not the key.

Page text and editable fields: `input`, `textarea`, `select`, and editable regions are not translated (`src/dom/blocks.ts`). A selection inside the field the reader is typing in is skipped too, because a text box reports its value through the document selection (`isTypedTextSelection` in `src/dom/blocks.ts`). The check follows an open shadow root to the control inside it; a field a page keeps in a closed shadow root is not reachable that way.

Chrome's Translator API is used only for a language pair the PLaMo model does not support, and only when Chrome reports the language pack as available. A pair the model supports is never routed to Chrome, so the page keeps its source text until PLaMo paints it. Chrome may download its own language packs. The agree-and-start button may call Translator.create() for the language pair so Chrome can install the pack. That call does not include page text. When the page has no language tag, the content script passes up to 1200 characters of the body to Chrome's on-device Language Detector (src/dom/detect.ts). When a pair is not one PLaMo supports and the source language is still empty, up to 1000 characters are passed the same way (src/engine/offscreen/host.ts, src/engine/chrome/translator.ts). Those calls are not requests this extension sends to a server. The extension does not upload page text to the developer, Preferred Networks, or any other third-party translation server. A local OpenAI-compatible server is used only when the user enables it in Settings; text then goes only to the address they set.

Model pins from src/engine/model/catalog.ts:

0.8B default
id plamo-3-translate-0.8b-q4_k_m
repo pfnet/plamo-3-translate-0.8b-GGUF
file plamo-3-translate-0.8b-Q4_K_M.gguf
commit dbeb0856cb0b004b484f190bb71dd65876297013
size 573123200
sha256 923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd
url https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/dbeb0856cb0b004b484f190bb71dd65876297013/plamo-3-translate-0.8b-Q4_K_M.gguf

2B optional
id plamo-3-translate-2b-q4_k_m
repo pfnet/plamo-3-translate-2b-GGUF
file plamo-3-translate-2b-Q4_K_M.gguf
commit 232fbd7916519edecddfdae0beae7e76fe70453f
size 1807199392
sha256 f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0
url https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/232fbd7916519edecddfdae0beae7e76fe70453f/plamo-3-translate-2b-Q4_K_M.gguf

The packaged runtime is the pinned wllama build (commit d275dac17bc7f190161deb24fd834ce03342e2bc, llama.cpp 5aeac37a35b44fde4bdffaec9159f2fcb253b622). It is compiled into the zip. It is not downloaded at runtime. The listing does not claim a GPU speed. The repository's `bench/results/pages/` holds live WebGPU runs from one machine (an RTX 4070 Ti SUPER); they are one machine's measurement, not a speed the extension promises.
```

文字数: 5664

## モデルのピン

`src/engine/model/catalog.ts` の値です。標準は 0.8B です。2B は利用者が選んだときだけ取得します。

| モデル     | 0.8B（標準）                                                       | 2B（任意）                                                         |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| id         | `plamo-3-translate-0.8b-q4_k_m`                                    | `plamo-3-translate-2b-q4_k_m`                                      |
| リポジトリ | `pfnet/plamo-3-translate-0.8b-GGUF`                                | `pfnet/plamo-3-translate-2b-GGUF`                                  |
| ファイル   | `plamo-3-translate-0.8b-Q4_K_M.gguf`                               | `plamo-3-translate-2b-Q4_K_M.gguf`                                 |
| commit     | `dbeb0856cb0b004b484f190bb71dd65876297013`                         | `232fbd7916519edecddfdae0beae7e76fe70453f`                         |
| サイズ     | 573,123,200 バイト（表示は 573 MB）                                | 1,807,199,392 バイト（表示は約 1.81 GB）                           |
| SHA-256    | `923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd` | `f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0` |

URL は `https://huggingface.co/<repo>/resolve/<commit>/<file>` です。取得は `src/engine/model/download.ts` です。本文のない GET で、再開時だけ `Range` を付けます。`redirect` は `follow`、`credentials` は指定しません。バイト列はいったん同じ OPFS ディレクトリの `.part` ファイルへ書き、取得後に読み戻してピン留めした SHA-256 と照合します。一致したものだけを最終的な名前へ移し、不一致なら削除して先頭から一度だけ取得し直します。途中で止まった取得は `.part` を残すので、次は続きから再開します。次の起動では、サイズと記録済みダイジェストがピンと一致する保存済みファイルを使います。起動のたびにバイト列はハッシュし直しません。

実行する wasm と worker は zip の `vendor/wllama/` に同梱します。`scripts/verify-package.ts` が、`wllama.js`、`wllama.wasm`、`wllama-worker.js`、pthread と compat の wasm、およびライセンス文の存在を確認します。モデル重み（`.gguf`）が zip に入っている場合は拒否します。wllama の commit は `d275dac17bc7f190161deb24fd834ce03342e2bc`、llama.cpp は `5aeac37a35b44fde4bdffaec9159f2fcb253b622` です（`scripts/wllama/pins.ts`）。実行時にそのソースは取りに行きません。

拡張ページの CSP は `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` です。`'wasm-unsafe-eval'` は、同梱した wasm を動かすためです。

## 権限

`wxt.config.ts` のリリース用マニフェスト:

- `permissions`: `offscreen`, `storage`, `unlimitedStorage`, `activeTab`, `scripting`, `contextMenus`
- `optional_host_permissions`: `https://*/*`, `http://*/*`
- `host_permissions`: なし（テスト用ビルドだけ、ローカルのフィクスチャ向けに付くことがあります。`scripts/verify-package.ts` はリリース zip の `host_permissions` を拒否します）
- `optional_permissions`: なし
- `nativeMessaging`: なし。コードベースにも要求はありません

content script は `src/entrypoints/content.ts` の `registration: 'runtime'` です。インストール時に全サイトへ一致する `content_scripts` は置きません。注入は `src/shared/page-bridge.ts` の `scripting.executeScript` です。自動翻訳が `always` のサイトでは、そのオリジンが許可済みのときだけ注入します（`src/background/page-actions.ts`）。

ホスト権限の要求は、そのサイトの自動翻訳をオンにしたクリックの中と、設定でローカルサーバーをオンにしたときです。ポップアップの「このサイトを常に翻訳します」が `permissions.request` を呼びます。content script からの要求は、ジェスチャ付きの拡張ページが必要なため `grant.html` を開きます（`src/entrypoints/grant/App.svelte`）。要求するオリジンは、そのホストの `https://<host>/*` と `http://<host>/*` です（`src/dom/sites.ts` の `siteAccessOrigins`）。ローカルサーバーは `src/engine/local-server/permissions.ts` が loopback なら `http://127.0.0.1/*` など、それ以外なら入力したホストです。自動翻訳をオフにするとサイト規則は `ask` に戻ります。`permissions.remove` は呼びません。

## オンボーディング

初回インストールで `onboarding.html` を開きます。開始ボタンの文言は、英語が Agree to the license and start、日本語が「ライセンスに同意して開始」（`onboardingStart`）です。横の注意書きは次です。

- 英語: Starting means you agree to the whole PLaMo Community License. You must be 18 or older, or have a parent or guardian's consent (Article 2). This extension does not check your age or ask a guardian to confirm.
- 日本語: 開始すると、PLaMo Community License の全文に同意したものとみなされます。18歳以上であるか、保護者の同意が必要です（第2条）。この拡張機能は、年齢の確認や保護者への確認は行いません。

同じ場所に、第3条の商業利用の条件（個人利用と学術利用は登録不要、商業目的の範囲、PFN のフォームへの事前登録と直近事業年度の収入・売上が10億円以下という二つの条件、満たさなくなった場合は商業用ライセンスが必要）を示し、同梱ライセンス本文、公式ページ、登録フォームへのリンクを並べます。

`consentCheckbox` という文言キーはありません。オンボーディングのテンプレートにチェックボックスはありません。クリックは `src/entrypoints/onboarding/App.svelte` の `start()` で、`chrome.storage.local` の設定に次を書きます。

- `license`: `plamo-community`
- `version`: `2026-11-05`（`PLAMO_LICENSE_VERSION`。同梱ライセンス文の版）
- `acceptedAt`: ISO 時刻
- `ageNoticeShown`: `true`（同じクリックが書く。注意書きが画面に出ていたことだけを記録し、年齢や保護者の同意を確認した記録ではありません）

以前の記録にある `guardian: true` は、同じクリックが書いていた値です。同梱ライセンス文の版が変わっていなければ、読み込み時に `ageNoticeShown: true` として扱い、同意は有効なままにします。

## 端末に残るもの

- `chrome.storage.local` の `settings`: 訳先、文体、表示、同意、用語集、その他の設定（`src/shared/storage.ts`）。用語集は1リストあたり最大 5,000 件（`src/shared/glossary.ts`）。この上限は製品プランの枠ではなく、巨大な CSV や settings JSON を抑えるためのものです。`unlimitedStorage` があるため容量そのものは足り、翻訳プロンプトにはそのセグメントに出現する語だけを入れます
- `chrome.storage.local` の `siteRules`: ホストごとの自動翻訳、表示、訳先、用語集（`src/dom/sites.ts`）。サイト用語集も同じ 5,000 件。翻訳メッセージはグローバルとサイトを合わせた最大 10,000 件まで受け付けます（`src/engine/offscreen/protocol.ts`）
- `chrome.storage.local` の `qualitySample`: 固定段落のモデル id、所要時間、時刻。ページ本文は入れません（`src/shared/quality.ts`、段落は `src/engine/model/suggestion.ts` の `QUALITY_PARAGRAPH`）
- `chrome.storage.session`: WebGPU の可否、cross-origin isolation、ハードウェア並列数の短いキャッシュ
- OPFS の `sakutto` ディレクトリ: モデルファイル（`src/engine/model/file-store.ts`）。既定の保存先
- Chromium のみ、任意の共有フォルダ: 設定画面の `showDirectoryPicker`（`startIn: 'documents'`）。案内はドキュメントで「Sakutto」を新規作成（または開いて）ドキュメント\\Sakutto を選ぶこと。Chromium の初回は共有フォルダがおすすめ・先頭・選択済み。Firefox とピッカーなしは OPFS のみ。Chromium は Documents / Desktop / ホーム / Downloads そのものの選択を拒否する（`docs/design/shared-model-folder.md`）。ハンドルは IndexedDB `sakutto-model-folder`。ファイルは `<chosen>/sakutto-models/<公式 PFN ファイル名>`。offscreen / service worker はピッカーも `requestPermission` も出せないので、`queryPermission` が `granted` のときだけハンドルから読む。採用時と size / lastModified の変化時にカタログの SHA-256 を照合する（`src/engine/model/integrity.ts`）。共有フォルダを設定すると、OPFS にある検証済みの公式モデルを `sakutto-models` へ移す（`.part` に書いてサイズと SHA-256 を確認してから改名し、成功後に OPFS を消す。失敗時は OPFS を残し途中の `.part` は捨てる。`src/engine/model/copy.ts`）。フォルダ権限が失われたときは再ダウンロードせず、既存の許可案内を出す。ピッカーを出したページが閉じると Chrome がディレクトリ許可を取り消すことがある（`docs/design/fsa-permission-lifetime.md`）。マニフェスト権限は増やしていない
- IndexedDB `sakutto-translations`: 訳文、エンジン種別、時刻。最大 5,000 件。キーは原文の SHA-256 と用語集のハッシュで、原文そのものはキーに入れません（`src/engine/cache/store.ts`、`src/engine/cache/key.ts`）

入力翻訳（`typed.html`）は1リクエストあたり最大 100,000 文字です（`src/shared/typed-translation.ts` の `MAX_TYPED_CHARS`、offscreen プロトコルの `MAX_SEGMENT_TEXT`）。この上限は文字課金ではなく、1件の chrome.runtime メッセージを抑えるためのものです。モデルは従来どおり段落サイズに分割して訳します。ページの周辺文脈（`context`）はこれまで通り最大 20,000 文字です。

`input`、`textarea`、`select`、編集できる領域は翻訳対象から外します（`src/dom/blocks.ts`）。

## 翻訳が端末内であることの範囲

内蔵エンジンについての拡張機能自身の通信は、上の GGUF 取得です。ページ本文、選択範囲、用語集、訳文を載せるリクエストはありません。設定でローカルサーバーをオンにしたときだけ、設定したアドレスへ `/v1/completions` で PFML3 を送ります（既定は loopback）。`chrome.runtime.requestUpdateCheck` と `chrome.storage.sync` は使いません。

Chrome の Translator API を使うのは、PLaMo のモデルが対応していない言語の組み合わせで、かつ Chrome が言語パックを `available` と報告しているときだけです（`src/engine/router.ts`、`src/engine/chrome/translator.ts`）。モデルが対応する組み合わせを Chrome に回すことはないため、モデルが描画するまでは原文のまま表示します。言語パックの取得は Chrome です。「はじめる」は、パックが `downloadable` でもクリック中に `Translator.create()` を呼ぶことがあります（`src/shared/translator-pack.ts`）。この呼び出しにページ本文はありません。ページに言語タグがないとき、content script が本文から最大 1,200 文字を Chrome の端末内 Language Detector に渡します（`src/dom/detect.ts`）。PLaMo が対応しない組み合わせでソース言語がまだ空のときは、最大 1,000 文字を同じ API に渡します（`src/engine/offscreen/host.ts`、`src/engine/chrome/translator.ts`）。これらは、この拡張機能がサーバーへ送るリクエストではありません。

速度の数値は審査メモの主張にしません。`bench/results/pages/` の live WebGPU 記録は 1 台のマシン（RTX 4070 Ti SUPER）での計測で、拡張機能が約束する速度ではありません。
