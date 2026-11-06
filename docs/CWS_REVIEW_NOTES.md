# Chrome Web Store review notes

Reviewer-facing facts for the current tree. The source of truth for model pins is `src/engine/model/catalog.ts`. The release permission list is `wxt.config.ts`. Package checks are `scripts/verify-package.ts`. Onboarding copy is `public/_locales/en/messages.json` and `public/_locales/ja/messages.json`. Consent storage is `src/shared/settings.ts` and `src/entrypoints/onboarding/App.svelte`.

Repository: https://github.com/jammaru/sakutto

Privacy policy: https://github.com/jammaru/sakutto/blob/main/PRIVACY.md

That privacy URL loads for a logged-out reviewer only after the owner makes the repository public. Preparing these notes does not publish the repository and does not submit the item.

The packaged name is Sakutto in both locales (`extensionName` and `extensionShortName`). The older titles Sakutto for PLaMo and サクッと翻訳 for PLaMo are not the current name. The item is unofficial and is not a Preferred Networks product. The UI says Built with PLaMo.

Paste the block below into the reviewer notes field. The same pins are repeated in Japanese afterwards so the owner can read them without the English block.

## Notes to paste

```text
Sakutto (https://github.com/jammaru/sakutto) translates web pages on the device. It is unofficial and is not affiliated with Preferred Networks. Built with PLaMo. The packaged name in _locales/en and _locales/ja is Sakutto. There is no account, no analytics, and no telemetry.

Single purpose: translating web pages.

Privacy policy: https://github.com/jammaru/sakutto/blob/main/PRIVACY.md

Remote code: モデル重み（GGUF データ）のみを huggingface.co から DL。実行コードはすべて同梱。
The only fetch this extension makes is a PLaMo 3 Translate GGUF weight from huggingface.co. The URL is pinned to a commit. The file is checked with SHA-256 before use, and a mismatch is discarded. The request has no body. Page text is not included. Hugging Face can see the IP address and the file request. Redirects are followed. credentials is omitted. Every script, worker, and wasm the extension executes is in the zip under vendor/wllama/. The extension does not request nativeMessaging.

Release manifest permissions: offscreen, storage, unlimitedStorage, activeTab, scripting, contextMenus. optional_host_permissions: https://*/* and http://*/*. host_permissions is empty at install. optional_permissions is empty. The content script is registered at runtime and injected with scripting.executeScript. It is not granted for every site at install.

Optional host permission is requested only when automatic translation is turned on for one site. The request is that host (https and http), from the popup or from the grant page during the click. Turning automatic translation off stores the site rule as ask. The code does not call permissions.remove.

Onboarding is one click on the agree-and-start button: Agree to the license and start (ライセンスに同意して開始). There is no consent checkbox. The button stores, in chrome.storage.local, license plamo-community, version 2026-11-05, an ISO timestamp, and ageNoticeShown: true. ageNoticeShown records only that the notice was on screen for that click. It is not a verification of age or of a guardian's consent, and the page has no guardian control. The notice beside the button says: "Starting means you agree to the whole PLaMo Community License. You must be 18 or older, or have a parent or guardian's consent (Article 2). This extension does not check your age or ask a guardian to confirm." The same panel summarizes the Article 3 commercial conditions and links to the bundled license texts, the official pages, and PFN's registration form.

Stored on the device: settings, glossary, per-site rules, and that consent record in chrome.storage.local; a timing sample for a fixed paragraph (model id, duration, timestamp; not page text); a short capabilities cache in chrome.storage.session; the model file in the OPFS directory sakutto; a translation cache in IndexedDB database sakutto-translations (at most 5000 rows). The cache key includes a SHA-256 of the source text and a hash of the glossary. The source text itself is not the key.

Chrome's Translator API is used only for a language pair the PLaMo model does not support, and only when Chrome reports the language pack as available. A pair the model supports is never routed to Chrome, so the page keeps its source text until PLaMo paints it. Chrome may download its own language packs. The agree-and-start button may call Translator.create() for the language pair so Chrome can install the pack. That call does not include page text. If the source language is empty, up to 1000 characters of page text may be passed to Chrome's Language Detector API. The extension does not choose a translation server and does not upload page text to the developer, Preferred Networks, or any other translation server.

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

The packaged runtime is the pinned wllama build (commit d275dac17bc7f190161deb24fd834ce03342e2bc, llama.cpp 5aeac37a35b44fde4bdffaec9159f2fcb253b622). It is compiled into the zip. It is not downloaded at runtime. The listing does not claim a GPU speed. WebGPU and n_parallel on a real GPU are unmeasured in this repository.
```

文字数: 4842

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

URL は `https://huggingface.co/<repo>/resolve/<commit>/<file>` です。取得は `src/engine/model/download.ts` です。本文のない GET で、再開時だけ `Range` を付けます。`redirect` は `follow`、`credentials` は指定しません。保存前に SHA-256 がピンと一致することを確認し、不一致なら捨てます。

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

ホスト権限の要求は、そのサイトの自動翻訳をオンにしたクリックの中だけです。ポップアップの「このサイトを常に翻訳します」が `permissions.request` を呼びます。content script からの要求は、ジェスチャ付きの拡張ページが必要なため `grant.html` を開きます（`src/entrypoints/grant/App.svelte`）。要求するオリジンは、そのホストの `https://<host>/*` と `http://<host>/*` です（`src/dom/sites.ts` の `siteAccessOrigins`）。自動翻訳をオフにするとサイト規則は `ask` に戻ります。`permissions.remove` は呼びません。

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

- `chrome.storage.local` の `settings`: 訳先、文体、表示、同意、用語集、その他の設定（`src/shared/storage.ts`）
- `chrome.storage.local` の `siteRules`: ホストごとの自動翻訳、表示、訳先、用語集（`src/dom/sites.ts`）
- `chrome.storage.local` の `qualitySample`: 固定段落のモデル id、所要時間、時刻。ページ本文は入れません（`src/shared/quality.ts`、段落は `src/engine/model/suggestion.ts` の `QUALITY_PARAGRAPH`）
- `chrome.storage.session`: WebGPU の可否、cross-origin isolation、ハードウェア並列数の短いキャッシュ
- OPFS の `sakutto` ディレクトリ: モデルファイル（`src/engine/model/file-store.ts`）
- IndexedDB `sakutto-translations`: 訳文、エンジン種別、時刻。最大 5,000 件。キーは原文の SHA-256 と用語集のハッシュで、原文そのものはキーに入れません（`src/engine/cache/store.ts`、`src/engine/cache/key.ts`）

`input`、`textarea`、`select`、編集できる領域は翻訳対象から外します（`src/dom/blocks.ts`）。

## 翻訳が端末内であることの範囲

拡張機能自身の通信は、上の GGUF 取得です。ページ本文、選択範囲、用語集、訳文を載せるリクエストはありません。`chrome.runtime.requestUpdateCheck` と `chrome.storage.sync` は使いません。

Chrome の Translator API を使うのは、PLaMo のモデルが対応していない言語の組み合わせで、かつ Chrome が言語パックを `available` と報告しているときだけです（`src/engine/router.ts`、`src/engine/chrome/translator.ts`）。モデルが対応する組み合わせを Chrome に回すことはないため、モデルが描画するまでは原文のまま表示します。言語パックの取得は Chrome です。「はじめる」は、パックが `downloadable` でもクリック中に `Translator.create()` を呼ぶことがあります（`src/shared/translator-pack.ts`）。この呼び出しにページ本文はありません。原文言語が空のとき、最大 1,000 文字を Chrome の Language Detector API に渡します（`src/engine/offscreen/host.ts`）。

速度の数値は審査メモの主張にしません。WebGPU と `n_parallel` を実 GPU で測った結果は、このリポジトリにありません。
