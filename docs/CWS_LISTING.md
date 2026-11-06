# Chrome ウェブストア掲載文

Developer Dashboard に貼る文です。日本語が主で、英語は後半です。このファイルはストアへ提出せず、リポジトリの公開状態も変えません。拡張機能の動作も変えません。

文字数は、各コードブロックの中身です。行と行の間の改行を含み、最後の行の後ろの余分な改行は含みません。絵文字はありません。名前は 75、概要は 132、詳細な説明は 16000 が上限です。権限の理由とリモートコードの欄は、ダッシュボード側の上限が短いことがあるため、それぞれ 1000 文字未満にしています。

翻訳速度の数値は入れていません。WebGPU と `n_parallel` を実 GPU で測った値は、このリポジトリの文書にもベンチ結果にもありません。

## 名前の確認

`public/_locales/en/messages.json` と `public/_locales/ja/messages.json` の `extensionName` と `extensionShortName` は、どちらも `Sakutto` です。以前の公開名 `Sakutto for PLaMo` と `サクッと翻訳 for PLaMo` は、表示名から外してあります。アイテム名には `Sakutto` を貼ります。マニフェストの短い名前も `Sakutto`（7 文字、上限 12）です。

「Built with PLaMo」は、名前ではなく、説明の先頭と画面上の表示に残します。PLaMo Community License 第4条の表示です。

## 日本語

### アイテム名

```text
Sakutto
```

文字数: 7 / 75

### 概要

`extensionDescription` と同じ文字列です。

```text
非公式。Preferred Networks とは無関係です。PLaMo 3 でページを端末内で翻訳します。Built with PLaMo。
```

文字数: 71 / 132

### 詳細な説明

先頭行は、画面の非公式表示（`unofficialNotice`）と同じ文です。

```text
非公式。Preferred Networks とは無関係です。Built with PLaMo。

Sakutto は、ウェブページをこの端末の中で翻訳する無料のオープンソース（MIT）拡張機能です。アカウントはありません。広告、分析、テレメトリもありません。

翻訳は端末上で行います。ページの本文、選択した文字、用語集、訳文は、開発者にも、Preferred Networks にも、その他の翻訳サーバーにも送りません。

拡張機能自身が通信するのは、PLaMo 3 Translate の GGUF モデル重みを、公式の Hugging Face リポジトリから取得するときだけです。URL はコミットでピン留めし、使う前に SHA-256 を確認します。一致しなければ捨てます。リクエストは huggingface.co から始まり、Hugging Face のリダイレクト先へ続きます。Hugging Face とその配信先には、IP アドレスとファイルのリクエストが届きます。ページの本文は含みません。

モデル重み（GGUF データ）のみを huggingface.co から DL。実行コードはすべて同梱。

標準モデルは 0.8B です。大きさは 573 MB（573,123,200 バイト）で、この端末に保存されていないときだけダウンロードします。2B（約 1.81 GB、1,807,199,392 バイト）は任意です。モデルの準備ができるまで、ページ翻訳は Chrome が言語パックを利用可能と報告しているときに Chrome 内蔵の翻訳を使うことがあります。言語パックは Chrome が取得します。「はじめる」は、ページ本文を含めずに Chrome へ言語パックの導入を頼むことがあります。原文の言語が空のときは、組み合わせを決めるために最大 1,000 文字を Chrome の Language Detector API に渡すことがあります。これは、この拡張機能から翻訳サーバーへの送信ではありません。

表示は、原文を訳文に置き換える方法と、原文と訳文を並べる対訳です。言語と表示はサイトごとに記憶できます。最初の開始は「はじめる」のワンクリックです。ボタンの横の注意書きが同意の文です。開始すると、PLaMo Community License（第2条）に同意したことになり、18歳以上であるか、保護者の同意が必要です。同意用のチェックボックスはありません。

インストール時に、すべてのサイトへのアクセスは要求しません。サイトの自動翻訳をオンにしたときだけ、そのサイトのホスト権限を求めます。開いているページの翻訳は、その操作のときに行います。

PLaMo 3 Translate は 53 言語です。Chrome 116 以降で動きます。

ピン留めしているファイル:

0.8B plamo-3-translate-0.8b-Q4_K_M.gguf
commit dbeb0856cb0b004b484f190bb71dd65876297013
573,123,200 バイト
SHA-256 923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd
https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/dbeb0856cb0b004b484f190bb71dd65876297013/plamo-3-translate-0.8b-Q4_K_M.gguf

2B plamo-3-translate-2b-Q4_K_M.gguf
commit 232fbd7916519edecddfdae0beae7e76fe70453f
1,807,199,392 バイト
SHA-256 f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0
https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/232fbd7916519edecddfdae0beae7e76fe70453f/plamo-3-translate-2b-Q4_K_M.gguf

プライバシーポリシー: https://github.com/jammaru/sakutto/blob/main/PRIVACY.md
```

文字数: 1909 / 16000

### カテゴリ

Productivity。ウェブページを翻訳する用途に合います。

### 言語

ストアの掲載言語は日本語を主にし、英語も追加します。拡張機能の `default_locale` は `en` で、UI の文言は英語と日本語です。掲載言語の欄に、翻訳できる 53 言語を並べる欄ではありません。53 は PLaMo 3 Translate の対応言語数で、`src/shared/languages.ts` の `SUPPORTED_LANGUAGES` です。

### 単一の目的

```text
この拡張機能の単一の目的は、ウェブページを翻訳することです。
```

文字数: 30

### 権限の理由

リリース用マニフェスト（`wxt.config.ts`）が要求するのは、次の 6 つだけです。`nativeMessaging` はありません。`optional_permissions` も空です。インストール時の `host_permissions` も空です。`optional_host_permissions` は `https://*/*` と `http://*/*` です。

`storage`

```text
訳先の言語、表示、用語集、サイトごとの規則、ライセンス同意の記録、固定文の計測結果を、この端末の chrome.storage.local に保存します。
```

文字数: 77

`unlimitedStorage`

```text
ダウンロードしたモデルファイルと翻訳キャッシュを、この端末に保持します。標準モデルは 573,123,200 バイトです。翻訳回数やディスク容量が無制限という意味ではありません。
```

文字数: 89

`offscreen`

```text
翻訳ランタイムを、Service Worker より長く動く文書で実行します。モデルの読み込みと翻訳を、その文書の中で行います。
```

文字数: 64

`activeTab`

```text
ポップアップ、ショートカット、または右クリックで翻訳を頼んだとき、開いているタブのページを読みます。
```

文字数: 50

`scripting`

```text
翻訳を頼んだタブ、または自動翻訳を許可済みのタブに、同梱の content script を注入します。インストール時にすべてのサイトへは注入しません。
```

文字数: 76

`contextMenus`

```text
右クリックメニューに、ページの翻訳と、選択したテキストの翻訳を追加します。
```

文字数: 37

任意のホスト権限（`https://*/*` と `http://*/*`）

```text
インストール時には要求しません。あるサイトの自動翻訳をオンにしたときだけ、そのホストの https と http を要求します。すべてのサイトを一括では要求しません。
```

文字数: 83

`nativeMessaging` は要求していません。理由の欄は出ない想定です。出た場合も、使う権限としては記入しません。

### リモートコード

詳細な説明にも、同じ日本語の文を入れてあります。この欄には短い方を貼ります。

```text
モデル重み（GGUF データ）のみを huggingface.co から DL。実行コードはすべて同梱。GGUF は公式リポジトリのコミットでピン留めし、SHA-256 を確認してから使います。ページ本文はリクエストに含めません。実行するスクリプト、worker、wasm は zip に入っています。
```

文字数: 151

### プライバシーポリシーの URL

```text
https://github.com/jammaru/sakutto/blob/main/PRIVACY.md
```

文字数: 55

この URL は、所有者が https://github.com/jammaru/sakutto を公開したあとでなければ、ログインしていない閲覧者には開けません。この変更ではリポジトリを公開しません。提出する前に、ログアウトしたブラウザでこの URL が `PRIVACY.md` を表示することを確認してください。非公開のままでは、審査者はポリシーを読めません。

## English

The item name matches `extensionName`. The summary matches `extensionDescription`.

### Item name

```text
Sakutto
```

文字数: 7 / 75

### Summary

```text
Unofficial. Not affiliated with Preferred Networks. Translates web pages on your device with PLaMo 3. Built with PLaMo.
```

文字数: 119 / 132

### Detailed description

The first line matches `unofficialNotice`.

```text
Unofficial. Not affiliated with Preferred Networks. Built with PLaMo.

Sakutto is a free, open-source (MIT) extension that translates web pages on this device. It has no account, no ads, no analytics, and no telemetry.

Translation runs on the device. Page text, selections, the glossary, and translations are not sent to the developer, to Preferred Networks, or to any other translation server.

The extension's own network requests download PLaMo 3 Translate GGUF model weights from the official Hugging Face repositories. Each URL is pinned to a commit and checked with SHA-256 before use. A mismatch is discarded. The request starts at huggingface.co and follows Hugging Face's redirect. Hugging Face and that host can see the IP address and the file request. Page text is not included.

モデル重み（GGUF データ）のみを huggingface.co から DL。実行コードはすべて同梱。
Only model weights (GGUF data) are downloaded from huggingface.co. Every script, worker, and wasm the extension executes is in the zip.

The default model is 0.8B, 573 MB (573,123,200 bytes). It downloads to the device when it is not already stored. The 2B model (about 1.81 GB, 1,807,199,392 bytes) is optional. Until the model is ready, page translation can use Chrome's built-in translator when Chrome reports the language pack as available. Chrome may download its own language packs. Get started can ask Chrome to install a pack, and that call does not include page text. If the source language is empty, up to 1,000 characters may be passed to Chrome's Language Detector API so the pair can be chosen. That is not a request from this extension to a translation server.

Reading styles are replace-original and bilingual. Language and reading style can be remembered per site. Starting is one click on Get started. The notice beside the button says that starting agrees to the PLaMo Community License (Article 2), and that you must be 18 or older or have a parent or guardian's consent. There is no consent checkbox.

Host access is not requested for every site at install. Optional host permission is requested only when automatic translation is turned on for a site. Translating the open page happens when you ask for it.

PLaMo 3 Translate covers 53 languages. The extension requires Chrome 116 or later.

Pinned files:

0.8B plamo-3-translate-0.8b-Q4_K_M.gguf
commit dbeb0856cb0b004b484f190bb71dd65876297013
573,123,200 bytes
SHA-256 923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd
https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/dbeb0856cb0b004b484f190bb71dd65876297013/plamo-3-translate-0.8b-Q4_K_M.gguf

2B plamo-3-translate-2b-Q4_K_M.gguf
commit 232fbd7916519edecddfdae0beae7e76fe70453f
1,807,199,392 bytes
SHA-256 f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0
https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/232fbd7916519edecddfdae0beae7e76fe70453f/plamo-3-translate-2b-Q4_K_M.gguf

Privacy policy: https://github.com/jammaru/sakutto/blob/main/PRIVACY.md
```

文字数: 2981 / 16000

### Category

Productivity. It fits an extension whose purpose is translating web pages.

### Language

Add Japanese as the primary store language and English as well. The extension `default_locale` is `en`, and the UI strings exist for `en` and `ja`. The store language field is not the list of 53 translation languages.

### Single purpose

```text
The extension's single purpose is translating web pages.
```

文字数: 56

### Permission justifications

The release manifest requests only `offscreen`, `storage`, `unlimitedStorage`, `activeTab`, `scripting`, and `contextMenus`. It does not request `nativeMessaging`. `optional_permissions` is empty. Install-time `host_permissions` is empty. `optional_host_permissions` is `https://*/*` and `http://*/*`.

`storage`

```text
Saves the target language, reading style, glossary, per-site rules, the license consent record, and a timing sample for a fixed paragraph in chrome.storage.local on this device.
```

文字数: 177

`unlimitedStorage`

```text
Keeps the downloaded model file and the translation cache on this device. The default model is 573,123,200 bytes. This is not a promise of unlimited translations or unlimited disk.
```

文字数: 180

`offscreen`

```text
Runs the translation runtime in a document that outlives the service worker. Model loading and translation happen in that document.
```

文字数: 131

`activeTab`

```text
Reads the open tab when you translate from the popup, a shortcut, or the right-click menu.
```

文字数: 90

`scripting`

```text
Injects the packaged content script into a tab you asked to translate, or into a tab whose site already has automatic translation allowed. It does not inject into every site at install.
```

文字数: 185

`contextMenus`

```text
Adds Translate page and Translate selection to the right-click menu.
```

文字数: 68

Optional host permission (`https://*/*` and `http://*/*`)

```text
Not requested at install. Requested only for the host whose automatic translation you turn on, for both https and http. It is not a grant for every site at once.
```

文字数: 161

`nativeMessaging` is not requested. Leave that justification unused.

### Remote code

```text
モデル重み（GGUF データ）のみを huggingface.co から DL。実行コードはすべて同梱。Only GGUF model weights are downloaded from huggingface.co. They are pinned by commit and checked with SHA-256 before use. Page text is not in the request. Every script, worker, and wasm the extension executes is in the zip.
```

文字数: 276

### Privacy policy URL

```text
https://github.com/jammaru/sakutto/blob/main/PRIVACY.md
```

文字数: 55

This URL is publicly reachable only after the owner makes https://github.com/jammaru/sakutto public. This change does not publish the repository. Before submit, open the URL in a logged-out browser and confirm it shows `PRIVACY.md`. Reviewers cannot read the policy while the repository is private.

## 自分で入れるもの

このファイルには書きません。ダッシュボードで所有者が入力します。

- 開発者の連絡先メール。公開メールアドレスはリポジトリにありません。
- 日本の特定商取引法（トレーダー該当）の判断。該当するかは所有者が決めます。この文書は断定しません。
- Chrome ウェブストアの同意チェックと、データ利用の認定チェック。ページ本文は端末内で翻訳し、開発者、Preferred Networks、その他の翻訳サーバーへは送りません。販売、広告、信用判断には使いません。
- ストア用 zip とスクリーンショットのアップロード。zip の作り方は [RELEASING.md](RELEASING.md) です。スクリーンショットはこのリポジトリに用意していません。
- 提出ボタン。この文書をマージしても、ストアには提出されません。

掲載の日付は書いていません。
