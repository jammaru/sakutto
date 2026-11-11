# Privacy policy

Last updated: 2026-11-11

Sakutto is an unofficial extension for Chrome and Firefox that translates web pages on your device. This page describes what the extension does with data in plain terms. It describes the kinds of data involved and who can see them, not the internals of the implementation.

## At a glance

- Translation runs on your device by default. Page text is not sent to a translation server unless you turn on a local server in Settings. In that case the text is sent only to the address you set, usually a process on this computer.
- There is no account, no advertising, and no analytics or telemetry.
- The developer does not receive the pages you translate, your selections, your glossary, or the translations.
- The only file the extension downloads is the PLaMo model, from Hugging Face. A local server you start is a separate optional path.
- You can delete the model and clear the translation cache in the extension's settings, or remove the extension.

## About this extension

Sakutto is an unofficial extension. It is not a product of Preferred Networks, Inc., and it is not affiliated with them. The model weights are PLaMo 3 Translate, used under the PLaMo Community License. The interface says "Built with PLaMo." The license text is included with the extension, and the first-run screen explains it and records that you agreed.

## What the extension reads

When you ask it to translate a page, a selection, or text you type on its own typed-text page, or when a site is set to translate automatically, the extension reads the text it is about to translate, along with the settings you have entered.

That text is used only to produce a translation. By default that happens on your device. If you choose a local server in Settings, the same text is sent only to the address you set.

## What is not collected

The developer does not receive your page text, your selections, your glossary, or your translations. No account is created. The extension has no advertising, no analytics, no telemetry, and no crash reporting. Nothing is sold, and no data is used to build a profile of you.

## How translation works

PLaMo 3 Translate runs inside the extension on your device. The model file is not bundled with the extension: the extension downloads it from Hugging Face the first time it needs it, and keeps it on your device. After that, PLaMo translation does not need a network connection. By default that file stays in this browser. In Chrome, Edge, and other Chromium browsers you can choose a folder on this computer instead, so more than one of those browsers can use the same file. The folder stays on your device. Nothing is sent. Firefox keeps the model in the browser.

On Chrome, for language pairs PLaMo does not support, the extension uses Chrome's built-in translator, which also runs on the device. Chrome downloads the language packs for those pairs itself. When a page does not say what language it is in, Chrome's built-in language detector may look at some of the page text to work it out. These are Chrome features running on your device. They are not uploads that this extension sends to the developer or to Preferred Networks.

On Firefox those Chrome APIs are not used. Only the language pairs PLaMo supports are translated.

Settings can switch PLaMo requests from the built-in on-device engine to an experimental local OpenAI-compatible server you run yourself (for example mlx_lm.server or LM Studio). Translation accuracy is not guaranteed on that path. The developer does not operate that server. Text is sent only to the URL you enter. The default is this computer (`127.0.0.1` / `localhost`). A URL that is not this computer is blocked until you confirm a warning that page text will leave the machine.

## The download, and who can see it

The extension's own network request for the built-in engine is the model download from Hugging Face. Hugging Face, and the network that serves the file, can see your IP address and that a model file was requested. They do not receive the page text, your selections, your glossary, or your translations.

If you enable a local server, the extension also sends translation requests to the address you set. That process can see the text being translated. The developer does not receive it.

If you installed the extension from the Chrome Web Store or from addons.mozilla.org, the browser may update it. That is the browser's own request, not one this extension makes.

## Stored on your device

The extension keeps the following on your device and does not send it to the developer:

- your settings, such as the target language and the reading style;
- your glossary and your per-site rules;
- a record that you accepted the license;
- the model file (by default in this browser; optionally, in Chrome, Edge, and other Chromium browsers, in a folder you choose on this computer). Choosing a shared folder moves a model already in this browser into that folder so another profile can use it without downloading again;
- a local translation cache, so that the same text does not have to be translated twice;
- an optional local-server API key, stored in plain text in chrome.storage.local.

You can delete the model and clear the translation cache in the extension's settings. Stopping use of a shared folder does not delete the files in it unless you delete a model from Settings. Removing the extension removes the rest of what it stored in the browser.

## Text the extension leaves alone

The extension tries not to translate text you are typing into a form field, and it skips a selection made inside the field you are typing in. Ordinary page text is translated, including text that happens to contain personal information.

## Permissions

The extension is not given access to every site when you install it. A one-time translation of the current tab uses the access the browser grants for that action. Access to a particular site is optional, and is requested only when you turn that site on, for automatic translation. Access to a local server is also optional. It is requested when you turn that engine on or change a loopback address, and for a remote address only after you confirm the warning checkbox.

## Limited Use

The extension has a single purpose: translating web pages. The text it reads, your per-site rules, and your glossary entries are used only for that purpose. They are not sold, not used for advertising, not used for credit or eligibility decisions, and not read by the developer. The extension does not receive user data from Google APIs.

## Contact

Questions about this policy can be opened as an issue at https://github.com/jammaru/sakutto/issues. The source code is at https://github.com/jammaru/sakutto. The Chrome Web Store listing is at https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl.

# プライバシーポリシー

最終更新: 2026-11-11

Sakutto は、端末の中でウェブページを翻訳する、Chrome と Firefox 向けの非公式の拡張機能です。このページでは、拡張機能がデータをどう扱うかを平易に説明します。扱うデータの種類と、それを誰が見られるかに絞って書き、実装の細部には立ち入りません。

## 要点

- 既定では翻訳は端末の中で行います。設定でローカルサーバーをオンにしない限り、ページの本文を翻訳サーバーへ送ることはありません。オンにした場合は、設定したアドレス（通常はこの端末上のプロセス）にだけ送ります。
- アカウントはありません。広告も、分析も、テレメトリもありません。
- 開発者は、翻訳したページ、選択範囲、用語集、訳文を受け取りません。
- 拡張機能が取得するファイルは、Hugging Face から取る PLaMo のモデルだけです。自分で起動したローカルサーバーは、それとは別の任意の経路です。
- 設定画面でモデルを削除し、翻訳キャッシュを消せます。拡張機能を削除する方法もあります。

## この拡張機能について

Sakutto は非公式の拡張機能です。Preferred Networks, Inc. の製品ではなく、同社とは関係ありません。モデルの重みは PLaMo 3 Translate で、PLaMo Community License に従います。画面には「Built with PLaMo」と出します。ライセンスの本文は拡張機能に同梱しており、初回の画面で説明したうえで、同意したことを記録します。

## 拡張機能が読むもの

ページ、選択範囲、または拡張機能のテキスト入力ページに入力した文字の翻訳を頼んだとき、あるいは自動翻訳をオンにしたサイトでは、翻訳する文字と、入力済みの設定を読みます。

その文字は、訳文を作るためだけに使います。既定では端末の中で処理します。設定でローカルサーバーを選んだときは、同じ文字を設定したアドレスにだけ送ります。

## 収集しないもの

開発者は、ページの本文、選択範囲、用語集、訳文を受け取りません。アカウントは作りません。拡張機能に広告、分析、テレメトリ、クラッシュ報告はありません。データを販売することも、利用者のプロフィールを作ることに使うこともありません。

## 翻訳のしくみ

PLaMo 3 Translate は、拡張機能の中で、端末上で動きます。モデルのファイルは拡張機能に同梱しておらず、最初に必要になったときに Hugging Face から取得して端末に保存します。そのあとは、PLaMo の翻訳に通信は要りません。既定では、そのファイルはこのブラウザ内に置きます。Chrome や Edge など Chromium 系ブラウザでは、このパソコン上のフォルダを選んで、複数のブラウザで同じファイルを使えます。フォルダは端末の中にあります。どこかへ送ることはありません。Firefox では、モデルはこのブラウザ内のままです。

Chrome では、PLaMo が対応していない言語の組み合わせに Chrome 内蔵の翻訳を使います。これも端末の中で動きます。その言語の言語パックは Chrome 自身が取得します。ページが言語を示していないときは、Chrome 内蔵の言語判定が、ページの文字の一部を見ることがあります。いずれも端末上で動く Chrome の機能です。この拡張機能が開発者や Preferred Networks へ送るものではありません。

Firefox ではそれらの Chrome の機能は使いません。PLaMo が対応する言語の組み合わせだけを訳します。

設定で、PLaMo のリクエストを内蔵エンジンから、自分で起動した実験的な OpenAI 互換のローカルサーバー（mlx_lm.server や LM Studio など）へ切り替えられます。この経路の翻訳精度は保証しません。そのサーバーを運営するのは開発者ではありません。文字は入力した URL にだけ送ります。既定はこの端末（`127.0.0.1` / `localhost`）です。この端末ではない URL は、本文が端末の外へ出る旨の警告を確認するまで送りません。

## ダウンロードと、それを見られる範囲

内蔵エンジンについての、この拡張機能自身が行う通信は、Hugging Face からのモデルの取得です。Hugging Face と、ファイルを配信するネットワークには、IP アドレスと、モデルのファイルが要求されたことが伝わります。ページの本文、選択範囲、用語集、訳文は伝わりません。

ローカルサーバーを有効にすると、設定したアドレスへ翻訳リクエストも送ります。そのプロセスは翻訳する文字を見られます。開発者は受け取りません。

Chrome ウェブストアまたは addons.mozilla.org から入れた場合、ブラウザが拡張機能を更新することがあります。それはブラウザ自身の通信で、この拡張機能が行うものではありません。

## 端末に保存するもの

拡張機能は、次のものを端末に保存し、開発者へは送りません。

- 翻訳先の言語や文体などの設定
- 用語集とサイトごとの規則
- ライセンスに同意したことの記録
- モデルのファイル（既定はこのブラウザ内。Chrome や Edge など Chromium 系ブラウザでは、このパソコン上で選んだフォルダにも置けます）。共有フォルダを選ぶと、すでにこのブラウザ内にあるモデルをそのフォルダへ移すので、別のプロファイルは再ダウンロードなしで使えます
- 翻訳キャッシュ（同じ文章を二度訳さずに済ませるための、端末内の保存）
- 任意のローカルサーバー API キー（chrome.storage.local に平文で保存します）

モデルの削除と翻訳キャッシュの消去は、拡張機能の設定画面から行えます。共有フォルダの使用をやめても、設定画面でモデルを削除しない限り、そのフォルダのファイルは残ります。拡張機能を削除すると、ブラウザ内に残していたものは消えます。

## 翻訳しない文字

入力欄に入力中の文字は翻訳しないようにしています。入力中の欄の中で選択した範囲も対象外です。通常の本文は翻訳するため、個人に関する記述が本文に含まれていれば、その部分も翻訳されます。

## 権限

インストールした時点で、すべてのサイトへのアクセスが与えられるわけではありません。今開いているタブの一回だけの翻訳には、その操作に対してブラウザが与えるアクセスを使います。特定のサイトへのアクセスは任意で、そのサイトの自動翻訳をオンにしたときだけ要求します。ローカルサーバーへのアクセスも任意です。そのエンジンをオンにしたときやループバックのアドレスを変えたときに要求し、この端末ではない URL では警告のチェックを確認したあとで要求します。

## 限定的な利用

拡張機能の目的は、ウェブページを翻訳するという一つだけです。読み取った文字、サイトごとの規則、用語集は、その目的にだけ使います。販売せず、広告に使わず、信用や適格性の判断にも使わず、開発者が読むこともありません。拡張機能は Google API から利用者データを受け取りません。

## 連絡先

このポリシーについての質問は、https://github.com/jammaru/sakutto/issues の issue で受けます。ソースコードは https://github.com/jammaru/sakutto に、Chrome ウェブストアの掲載は https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl にあります。
