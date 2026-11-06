# Privacy policy

Sakutto translates web pages in Chrome. This page describes what the extension code does with data. It is a description of the program, not a legal opinion.

Checked against the code on 2026-11-06. If the code changes, this page has to change with it.

## Who operates the extension

The extension is unofficial. It is not a product of Preferred Networks, Inc. The model weights are PLaMo 3 Translate, used under the PLaMo Community License. The interface says "Built with PLaMo."

This repository's MIT copyright line names `jammaru`. That is the repository name, not a completed legal name of a store publisher.

## What the extension handles

The extension reads text from a page when you translate that page, a selection, or a site you have set to translate automatically. It also stores settings you enter.

It uses that text only to produce a translation on the device. The developer does not receive the page, the selection, the glossary, or the translation. There is no account, no analytics, and no telemetry in the extension. The extension does not call `chrome.runtime.requestUpdateCheck`, and it does not use `chrome.storage.sync`.

"This extension does not send page text to a server" is accurate for the extension's own requests. It is not a claim that Chrome's own language-pack download, Chrome Web Store update check, or a hosting provider's connection logs do not exist. Those are described below.

## Network requests made by the extension

The only URL the extension fetches is a pinned model file:

- `https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/dbeb0856cb0b004b484f190bb71dd65876297013/plamo-3-translate-0.8b-Q4_K_M.gguf`
- `https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/232fbd7916519edecddfdae0beae7e76fe70453f/plamo-3-translate-2b-Q4_K_M.gguf`

The code is `src/engine/model/catalog.ts` and `src/engine/model/download.ts`. The request has no body. A resume sends a `Range` header and nothing else from the page. `credentials` is omitted, so the default is same-origin and a Hugging Face cookie from the page's profile is not attached. On 2026-11-06 an unauthenticated request for each file was accepted (`gated: false` on the model API, `user_id=public` on the redirect). Hugging Face can change that later. The extension does not ship a token.

`redirect: 'follow'` means the browser then requests the host Hugging Face names. On 2026-11-06 that host was `https://us.aws.cdn.hf.co/`. The region can differ. That CDN receives the IP address, the usual browser request headers, and the signed URL for the file. It does not receive the page text. The `Link` header also named `https://cas-server.xethub.hf.co/`. `fetch` does not follow `Link` headers, and the extension has no Xet client, so that host is not requested by this code.

The 0.8B file is the default (573,123,200 bytes). The 2B file (1,807,199,392 bytes) is downloaded only after you choose it. Both are checked with the pinned SHA-256 before use. A mismatch is discarded.

## Requests the extension does not make

- No analytics, crash report, or telemetry endpoint.
- No request that includes page text, a glossary, or a translation.
- No extension-initiated update check. If you installed from the Chrome Web Store, Chrome may contact Google to update the extension. That is Chrome's request. It is not page text, and this program does not add one.
- Chrome's Translator API (`src/engine/chrome/translator.ts`) is used only for a language pair the PLaMo model does not support, and only when Chrome reports the language pack as `available` (`src/engine/router.ts`). A pair the model supports is never routed to Chrome, so no built-in text is shown as a stand-in while the model loads. The extension does not choose a server and does not upload the text itself. If the source language is empty, up to 1,000 characters of page text may first go to Chrome's Language Detector API so the extension can ask Translator about the right pair (`src/engine/offscreen/host.ts`). Onboarding's Get started button may call `Translator.create()` for the language pair even when the pack is still `downloadable`, so Chrome can install the pack (`src/shared/translator-pack.ts`). That call does not include page text. Google's Translator API documentation describes translation as client-side and says Chrome downloads the language pack. This policy does not claim an independent audit of Chrome.

## Stored on the device

- Settings, glossary, per-site rules, license consent, and a timing sample (`chrome.storage.local`, `src/shared/storage.ts`, `src/dom/sites.ts`, `src/shared/quality.ts`). Consent is recorded by one click on Get started. The notice beside that button states that starting agrees to Article 2 of the PLaMo Community License, including the requirement to be 18 or older or to have a parent or guardian's consent, and the page links to the license texts. The click writes license `plamo-community`, version `2026-11-05` (the bundled license text, `PLAMO_LICENSE_VERSION` in `src/shared/settings.ts`), an ISO timestamp, and `guardian: true`. The onboarding page has no consent checkbox, and `guardian: true` is part of that same record. The timing sample stores the model id, a duration, and a timestamp for a fixed paragraph. It does not store page text. `chrome.storage.local` is documented by Chrome as not encrypted, and as cleared when the extension is removed.
- A short-lived capabilities cache in `chrome.storage.session`.
- The model file, under the OPFS directory `sakutto` (`src/engine/model/file-store.ts`).
- A translation cache in IndexedDB, database `sakutto-translations` (`src/engine/cache/store.ts`). Each row stores the translation, which engine produced it, and timestamps. The key includes a SHA-256 of the source text and a hash of the glossary, not the source text itself. The cache keeps at most 5,000 rows and drops the least recently used. There is no time limit.

`input`, `textarea`, `select`, and editable regions are not translated (`src/dom/blocks.ts`). Ordinary page text is, including text that happens to contain personal information.

You can delete a model and clear the translation cache in settings. Changing or deleting the pinned model downloads it again. Removing the extension clears `chrome.storage.local`. IndexedDB and OPFS belong to the extension origin; the settings buttons are the explicit delete path. A Chrome sentence that names those two stores on uninstall was not found in the pages checked on 2026-11-05.

## Permissions

Nothing is requested for every site at install. `optional_host_permissions` is `https://*/*` and `http://*/*` so that a later, per-site grant is possible. The grant itself is only the host you turn on (`src/dom/sites.ts`). One-time translation of the current tab uses `activeTab` and `scripting`. The permission table is in [README.md](README.md).

`unlimitedStorage` raises Chrome's storage quota so the model file can be kept. It is not a promise of unlimited translations or unlimited disk.

## Limited Use

Page text, site rules, and glossary entries are used only to translate pages in this extension. They are not sold, not used for advertising, not used to assess credit, and not read by the publisher. The extension does not receive user data from a Google API. The store's example sentence about "information received from Google APIs" is therefore not a description of this program. The use that does occur is limited to the single purpose of translating web pages, including keeping the on-device model and the local cache that purpose needs.

## Accounts and offline use

The extension has no account. The model download did not require a Hugging Face login on 2026-11-06. After the checked file is stored, PLaMo translation does not need the network. Before that, it does. Chrome's built-in translator, used for the pairs the model does not support, also needs its language pack to be installed already. Neither path is offline on a new install with no files saved.

## Contact

Questions about this policy can be opened as an issue at https://github.com/jammaru/sakutto/issues. The repository is https://github.com/jammaru/sakutto. This file does not invent a publisher legal name or a public email. If a Chrome Web Store listing is published later, that listing will show the contact used for the listing.

# プライバシーポリシー

Sakutto は、Chrome でウェブページを翻訳します。このページは、拡張機能のコードがデータをどう扱うかを説明します。法的意見ではありません。

2026-11-06 のコードに合わせて確認しました。コードが変わったら、このページも変えます。

## 運営者

この拡張機能は非公式です。Preferred Networks, Inc. の製品ではありません。モデルの重みは PLaMo 3 Translate で、PLaMo Community License に従います。画面には「Built with PLaMo」と出します。

MIT の著作権表示にある `jammaru` はリポジトリ上の名前であり、ストア公開者の法的名称として記入済みではありません。

## 拡張機能が扱うもの

ページの翻訳、選択範囲の翻訳、または自動翻訳をオンにしたサイトの翻訳のときに、ページの文字を読みます。利用者が入力した設定も保存します。

その文字は、端末の中で訳文を作るためだけに使います。開発者は、ページ、選択範囲、用語集、訳文を受け取りません。拡張機能にアカウント、分析、テレメトリはありません。`chrome.runtime.requestUpdateCheck` は呼ばず、`chrome.storage.sync` も使いません。

「この拡張機能はページの本文をサーバーへ送らない」は、拡張機能自身のリクエストについて正確です。Chrome 自身の言語パック取得、Chrome ウェブストアの更新確認、ホスティング事業者の接続記録が存在しない、という意味ではありません。それらは下に書きます。

## 拡張機能が行う通信

拡張機能が取得するのは、ピン留めしたモデルファイルだけです。

- `https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/dbeb0856cb0b004b484f190bb71dd65876297013/plamo-3-translate-0.8b-Q4_K_M.gguf`
- `https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/232fbd7916519edecddfdae0beae7e76fe70453f/plamo-3-translate-2b-Q4_K_M.gguf`

コードは `src/engine/model/catalog.ts` と `src/engine/model/download.ts` です。リクエストに本文はありません。再開するときは `Range` ヘッダーだけで、ページの内容は送りません。`credentials` は指定しないため、既定の same-origin になり、プロフィールに保存された Hugging Face のクッキーは付きません。2026-11-06 には、認証なしのリクエストが両方のファイルで通りました（モデル API の `gated` は `false`、リダイレクトの `user_id` は `public`）。Hugging Face が後から制限することはあります。拡張機能はトークンを持ちません。

`redirect: 'follow'` のため、ブラウザは Hugging Face が示したホストへ続きます。2026-11-06 のホストは `https://us.aws.cdn.hf.co/` でした。地域によりホストは変わります。その CDN には、IP アドレス、通常のブラウザのヘッダー、ファイル用の署名付き URL が届きます。ページの本文は届きません。`Link` ヘッダーには `https://cas-server.xethub.hf.co/` も出ていました。`fetch` は `Link` をたどらず、この拡張機能に Xet のクライアントはないため、そのホストへは要求しません。

標準は 0.8B（573,123,200 バイト）です。2B（1,807,199,392 バイト）は、利用者が選んだときだけ取得します。どちらも、使う前にピン留めした SHA-256 で確認します。一致しなければ捨てます。

## 拡張機能が行わない通信

- 分析、クラッシュ報告、テレメトリのエンドポイントはありません。
- ページの本文、用語集、訳文を含むリクエストはありません。
- 拡張機能自身の更新確認はありません。Chrome ウェブストアから入れた場合、Chrome が Google に更新を問い合わせることがあります。それは Chrome の通信であり、ページの本文ではなく、このプログラムが追加するものでもありません。
- Chrome の Translator API（`src/engine/chrome/translator.ts`）を使うのは、PLaMo のモデルが対応していない言語の組み合わせで、かつ Chrome が言語パックを `available` と報告しているときだけです（`src/engine/router.ts`）。モデルが対応する組み合わせを Chrome に回すことはないため、モデルの読み込み中に Chrome 内蔵の訳が代わりに表示されることはありません。サーバーは選ばず、拡張機能自身は文字を送りません。ソース言語が空のときは、その前に最大 1,000 文字を Chrome の Language Detector API に渡して組み合わせを決めます（`src/engine/offscreen/host.ts`）。オンボーディングの開始では、言語パックが `downloadable` でもクリック中に `Translator.create()` し、Chrome がパックを入れられるようにすることがあります（`src/shared/translator-pack.ts`）。この呼び出しにページ本文は入りません。Google の Translator API の文書は、これを端末側の翻訳と説明し、言語パックは Chrome が取得するとしています。このポリシーは、Chrome 本体を独自に監査したとは言いません。

## 端末に保存するもの

- 設定、用語集、サイトごとの規則、ライセンスへの同意、計測の記録（`chrome.storage.local`。`src/shared/storage.ts`、`src/dom/sites.ts`、`src/shared/quality.ts`）。同意は「はじめる」のワンクリックで記録します。ボタンの横の注意書きには、開始すると PLaMo Community License の第2条に同意したことになり、18歳以上であるか保護者の同意が必要だと書きます。ライセンス本文へのリンクもあります。クリックが書く記録は、ライセンス名 `plamo-community`、版 `2026-11-05`（同梱しているライセンス文。`src/shared/settings.ts` の `PLAMO_LICENSE_VERSION`）、ISO 形式の時刻、`guardian: true` です。オンボーディングに同意用のチェックボックスはなく、`guardian: true` も同じ記録の一部です。計測の記録は、モデル ID、所要時間、固定の段落を測った時刻です。ページの本文は入れません。Chrome の文書では、`chrome.storage.local` は暗号化されず、拡張機能を削除すると消えます。
- 能力情報の短いキャッシュ（`chrome.storage.session`）。
- モデルファイル。OPFS の `sakutto` ディレクトリです（`src/engine/model/file-store.ts`）。
- 翻訳キャッシュ。IndexedDB の `sakutto-translations` です（`src/engine/cache/store.ts`）。各行は訳文、どちらのエンジンか、時刻です。キーには原文の SHA-256 と用語集のハッシュが入り、原文そのものは入りません。最大 5,000 件で、最も昔に使ったものから捨てます。期限はありません。

`input`、`textarea`、`select`、編集できる領域は翻訳しません（`src/dom/blocks.ts`）。通常の本文は翻訳します。その中に個人に関する記述が含まれることはあります。

設定画面から、モデルの削除と翻訳キャッシュの消去ができます。ピン留めしたモデルが変わるか、削除すると、取り直します。拡張機能を削除すると `chrome.storage.local` は消えます。IndexedDB と OPFS は拡張機能のオリジンにあります。明示的な削除は設定画面のボタンです。アンインストール時にその二つを名指しする Chrome の文は、2026-11-05 に確認したページにはありませんでした。

## 権限

インストール時に、すべてのサイトへの権限は要求しません。`optional_host_permissions` が `https://*/*` と `http://*/*` なのは、後からサイトごとに許可できるようにするためです。実際に要求するのは、オンにしたホストだけです（`src/dom/sites.ts`）。今開いているタブの一回だけの翻訳は `activeTab` と `scripting` を使います。権限の表は [README.ja.md](README.ja.md) にあります。

`unlimitedStorage` は、モデルファイルを保持できるよう Chrome の保存上限を広げる権限です。翻訳回数やディスク容量が無制限という意味ではありません。

## 限定的な利用

ページの本文、サイトの規則、用語集は、この拡張機能でページを翻訳するためだけに使います。販売せず、広告に使わず、信用判断に使わず、公開者が読みません。拡張機能は Google API から利用者データを受け取りません。したがって、ストアの例文にある「Google API から受け取った情報」は、このプログラムの説明にはなりません。実際の利用は、ウェブページを翻訳するという単一の目的と、そのために必要な端末内のモデルとローカルなキャッシュに限られます。

## アカウントとオフライン

拡張機能にアカウントはありません。2026-11-06 のモデル取得に、Hugging Face へのログインは不要でした。検査済みのファイルが保存されたあと、PLaMo の翻訳に通信は不要です。保存前には必要です。モデルが対応しない言語で使う Chrome 内蔵の翻訳も、言語パックが既に入っていることが必要です。何も保存していない新規導入では、どちらの経路もオフラインでは完了しません。

## 連絡先

このポリシーについての質問は、https://github.com/jammaru/sakutto/issues の issue で受けます。リポジトリは https://github.com/jammaru/sakutto です。このファイルは、公開者の法的名称や公開メールを作りません。Chrome ウェブストアの掲載が後から出る場合、その掲載に使う連絡先は、その掲載に出ます。
