# Chrome ウェブストア掲載文

Developer Dashboard に貼る文です。日本語が主で、英語は後半です。このファイルはストアへ提出せず、リポジトリの公開状態も変えません。拡張機能の動作も変えません。

文字数は、各コードブロックの中身です。行と行の間の改行を含み、最後の行の後ろの余分な改行は含みません。絵文字はありません。名前は 75、概要は 132、詳細な説明は 16000 が上限です。権限の理由とリモートコードの欄は、ダッシュボード側の上限が短いことがあるため、それぞれ 1000 文字未満にしています。

翻訳速度の数値は入れていません。WebGPU と `n_parallel` を実 GPU で測った値は、このリポジトリの文書にもベンチ結果にもありません。

## 名前の確認

`public/_locales/en/messages.json` と `public/_locales/ja/messages.json` の `extensionName` は、英語が `Sakutto - Local AI translation`、日本語が `Sakutto - ローカルAI翻訳` です。`extensionShortName` はどちらも `Sakutto` です。以前の公開名 `Sakutto for PLaMo` と `サクッと翻訳 for PLaMo` は、表示名から外してあります。アイテム名と概要はダッシュボードでは読み取り専用で、zip の `_locales` から入ります。マニフェストの短い名前は `Sakutto`（7 文字、上限 12）です。

「Built with PLaMo」は、名前ではなく、概要の末尾と画面上の表示に残します。PLaMo Community License 第4条の表示です。

## 日本語

### アイテム名

```text
Sakutto - ローカルAI翻訳
```

文字数: 18 / 75

### 概要

`extensionDescription` と同じ文字列です。

```text
ローカルLLMが、この端末の中でページを翻訳します。アカウント不要の無料拡張機能です。Built with PLaMo。
```

文字数: 60 / 132

### 詳細な説明

```text
ウェブページを、この端末の中だけで翻訳する無料の拡張機能です。アカウント登録は不要です。広告も分析もありません。

ページ全体の翻訳、選択したテキストの翻訳、手元で入力して訳すことができます。原文を訳文に置き換える表示と、並べて読む対訳表示があります。

本文は外部の翻訳サーバーへ送りません。ローカルLLMが、この端末の中で訳します。Built with PLaMo。

非公式です。Preferred Networks とは無関係です。

プライバシーポリシー: https://jammaru.com/sakutto/privacy/
```

文字数: 270 / 16000

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

詳細な説明にはモデル取得の文を含めていないため、この欄で説明します。

```text
モデル重み（GGUF データ）のみを huggingface.co から DL。実行コードはすべて同梱。GGUF は公式リポジトリのコミットでピン留めし、SHA-256 を確認してから使います。ページ本文はリクエストに含めません。実行するスクリプト、worker、wasm は zip に入っています。
```

文字数: 151

### プライバシーポリシーの URL

```text
https://jammaru.com/sakutto/privacy/
```

文字数: 36

このページは、詳細な説明の末尾にも同じ URL で書いています。

## English

The item name matches `extensionName`. The summary matches `extensionDescription`.

### Item name

```text
Sakutto - Local AI translation
```

文字数: 30 / 75

### Summary

```text
A local LLM translates pages on your device. Free, no account. Built with PLaMo.
```

文字数: 80 / 132

### Detailed description

```text
A free extension that translates web pages on your device. No account. No ads or analytics.

Translate a whole page, selected text, or text you type. You can replace the page with the translation, or read the original and the translation side by side.

Your page text is not sent to an outside translation server. A local LLM translates on this device. Built with PLaMo.

Unofficial. Not affiliated with Preferred Networks.

Privacy policy: https://jammaru.com/sakutto/privacy/
```

文字数: 477 / 16000

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
https://jammaru.com/sakutto/privacy/
```

文字数: 36

The detailed description ends with the same URL.

## 自分で入れるもの

このファイルには書きません。ダッシュボードで所有者が入力します。

- 開発者の連絡先メール。公開メールアドレスはリポジトリにありません。
- 日本の特定商取引法（トレーダー該当）の判断。該当するかは所有者が決めます。この文書は断定しません。
- Chrome ウェブストアの同意チェックと、データ利用の認定チェック。ページ本文は端末内で翻訳し、開発者、Preferred Networks、その他の翻訳サーバーへは送りません。販売、広告、信用判断には使いません。
- ストア用 zip とスクリーンショットのアップロード。zip の作り方は [RELEASING.md](RELEASING.md) です。スクリーンショットはこのリポジトリに用意していません。
- 提出ボタン。この文書をマージしても、ストアには提出されません。

掲載の日付は書いていません。
