# Privacy policy

Last updated: 2026-11-21

Sakutto is an unofficial extension for Chrome and Firefox that translates web pages on your device. This page describes what the extension does with data in plain terms. It describes the kinds of data involved and who can see them, not the internals of the implementation.

## At a glance

- Translation runs on your device by default. Page text is not sent to a translation server unless you turn on a local server in Settings. In that case the text is sent only to the address you set, usually a process on this computer.
- There is no account, no advertising, and no analytics or telemetry.
- The developer does not receive the pages you translate, your selections, your glossary, or the translations.
- The only files the extension downloads from a third-party host are the PLaMo and PP-OCRv6 model weights, from Hugging Face. A local server you start is a separate optional path.
- To translate a PDF, the extension reads the PDF file from the site the tab is already showing. That request goes to that site and nowhere else.
- You can delete the model and clear the translation cache in the extension's settings, or remove the extension.

## About this extension

Sakutto is an unofficial extension. It is not a product of Preferred Networks, Inc., and it is not affiliated with them. The model weights are PLaMo 3 Translate, used under the PLaMo Community License. The interface says "Built with PLaMo." The license text is included with the extension, and the first-run screen explains it and records that you agreed.

## What the extension reads

When you ask it to translate a page, a selection, or text you type on its own typed-text page, or when a site is set to translate automatically, the extension reads the text it is about to translate, along with the settings you have entered.

That text is used only to produce a translation. By default that happens on your device. If you choose a local server in Settings, the same text is sent only to the address you set.

For a scanned PDF page with no usable text layer, Sakutto renders that page and recognizes its text on your device with PP-OCRv6. Pages with a usable text layer do not run OCR. When you choose Translate image from an image's context menu, Sakutto reads the image pixels on your device. It first tries the image's existing canvas data or an anonymous CORS read; if those fail, it captures the visible tab using the one-time activeTab grant from that click and crops the image area. No image-origin host permission is requested, and OCR pixels and recognized text are not uploaded.

When you open a PDF in the extension's reader, the extension reads the PDF file, not the page text: Chrome draws a PDF in its own viewer, which no extension can read. The file is fetched once from the address the tab already shows, with the cookies that tab already has, stored inside the extension on your device, and deleted when the reader tab closes. Reloading the reader tab is a close-and-open of that page, so the original PDF tab (or a file you pick) is needed again. If a tab cannot report that it closed, a leftover copy is removed within a day. It is not uploaded anywhere.

## What is not collected

The developer does not receive your page text, your selections, your glossary, or your translations. No account is created. The extension has no advertising, no analytics, no telemetry, and no crash reporting. Nothing is sold, and no data is used to build a profile of you.

## How translation works

PLaMo 3 Translate runs inside the extension on your device. The model file is not bundled with the extension: the extension downloads it from Hugging Face the first time it needs it, and keeps it on your device. After that, PLaMo translation does not need a network connection. On Chrome, Edge, and other Chromium browsers, first-run preselects a shared folder on this computer; browser storage remains available. Firefox stores the model in browser storage, and can copy official models from a shared folder once; the copies are checked before use. The folder and browser copy stay on your device. Nothing is sent.

PP-OCRv6 runs inside the extension on your device for scanned PDF and image OCR. Its detector and recognizer weights are not bundled. You choose when to download them: during first setup together with the translation model, or later from Settings. Using an OCR feature never starts a download on its own; if the weights are missing, the extension asks you to install them from Settings. The ONNX Runtime Web WASM and character dictionary are bundled locally. After the weights are installed, OCR needs no network connection.

On Chrome, for language pairs PLaMo does not support, the extension uses Chrome's built-in translator, which also runs on the device. Chrome downloads the language packs for those pairs itself. When a page does not say what language it is in, Chrome's built-in language detector may look at some of the page text to work it out. These are Chrome features running on your device. They are not uploads that this extension sends to the developer or to Preferred Networks.

On Firefox those Chrome APIs are not used. Only the language pairs PLaMo supports are translated.

Settings can switch PLaMo requests from the built-in on-device engine to an experimental local OpenAI-compatible server you run yourself (for example `mlx_lm.server`). Translation accuracy is not guaranteed on that path. The developer does not operate that server. Text is sent only to the URL you enter. The default is this computer (`127.0.0.1` / `localhost`). A URL that is not this computer is blocked until you confirm a warning that page text will leave the machine.

## The download, and who can see it

The extension's own network requests for the built-in engines are the PLaMo and PP-OCRv6 model downloads from Hugging Face. Hugging Face, and the network that serves the file, can see your IP address and that a model file was requested. They do not receive the page text, your selections, your glossary, or your translations.

Opening a PDF makes one request to the site the PDF tab is already on, asking for the same address the tab is showing, with the cookies that tab already has. That site already served you that file, so it learns nothing new from the request; the extension adds no parameters and sends no body. The file is never passed on to the developer or to any other server.

If you enable a local server, the extension also sends translation requests to the address you set. That process can see the text being translated. The developer does not receive it.

If you installed the extension from the Chrome Web Store or from addons.mozilla.org, the browser may update it. That is the browser's own request, not one this extension makes.

## Stored on your device

The extension keeps the following on your device and does not send it to the developer:

- your settings, such as the target language and the reading style;
- your glossary and your per-site rules;
- a record that you accepted the license;
- the PLaMo and OCR model files (in browser storage, or in Chrome, Edge, and other Chromium browsers, in a folder you choose on this computer). Choosing a shared folder moves verified browser copies into that folder; switching back copies verified folder models into browser storage and never deletes the folder files;
- a local translation cache, so that the same text does not have to be translated twice;
- an optional local-server API key, stored in plain text in chrome.storage.local;
- a copy of a PDF you opened in the reader, until that tab closes (a leftover is removed within a day).

You can delete the translation and OCR models and clear the translation cache in the extension's settings. Stopping use of a shared folder does not delete the files in it. Removing the extension removes the rest of what it stored in the browser.

## Text the extension leaves alone

The extension tries not to translate text you are typing into a form field, and it skips a selection made inside the field you are typing in. Ordinary page text is translated, including text that happens to contain personal information.

## Permissions

The extension is not given access to every site when you install it. The release package asks for no install-time host access. Image translation adds no host permission: its captureVisibleTab fallback uses only the activeTab grant from the image context-menu click. A one-time translation of the current tab uses the access the browser grants for that action. Access to any particular site is optional, and is requested only when you turn that site on for automatic translation, when you turn on video caption translation (YouTube and X), when you add a custom caption site, or when you enable the Gmail/Outlook message banner from the popup or Settings. When the all-sites choice is on, its single grant already covers those sites and no further prompt appears. There is also one all-sites choice, off by default: turning it on grants optional access to http/https pages so the selection button and the shortcuts are on the page from page load, with no per-site step. You can revoke it with the same control or from the browser's extension permission settings. This choice only lets the extension run its content script on pages; it does not upload page text, which still stays on your device as everywhere else in this policy. Access to a local server is also optional. It is requested when you turn that engine on or change a loopback address, and for a remote address only after you confirm the warning checkbox.

## Limited Use

The extension has a single purpose: translating web pages. The text it reads, your per-site rules, and your glossary entries are used only for that purpose. They are not sold, not used for advertising, not used for credit or eligibility decisions, and not read by the developer. The extension does not receive user data from Google APIs.

## Contact

Questions about this policy can be opened as an issue at https://github.com/jammaru/sakutto/issues. The source code is at https://github.com/jammaru/sakutto. The Chrome Web Store listing is at https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl.

# プライバシーポリシー

最終更新: 2026-11-21

Sakutto は、端末の中でウェブページを翻訳する、Chrome と Firefox 向けの非公式の拡張機能です。このページでは、拡張機能がデータをどう扱うかを平易に説明します。扱うデータの種類と、それを誰が見られるかに絞って書き、実装の細部には立ち入りません。

## 要点

- 既定では翻訳は端末の中で行います。設定でローカルサーバーをオンにしない限り、ページの本文を翻訳サーバーへ送ることはありません。オンにした場合は、設定したアドレス（通常はこの端末上のプロセス）にだけ送ります。
- アカウントはありません。広告も、分析も、テレメトリもありません。
- 開発者は、翻訳したページ、選択範囲、用語集、訳文を受け取りません。
- 拡張機能が取得するファイルは、Hugging Face から取る PLaMo と PP-OCRv6 のモデルだけです。自分で起動したローカルサーバーは、それとは別の任意の経路です。
- PDF を翻訳するときは、そのタブが表示しているサイトから PDF ファイルを読みます。この通信はそのサイトに対してだけで、ほかへは行きません。
- 設定画面でモデルを削除し、翻訳キャッシュを消せます。拡張機能を削除する方法もあります。

## この拡張機能について

Sakutto は非公式の拡張機能です。Preferred Networks, Inc. の製品ではなく、同社とは関係ありません。モデルの重みは PLaMo 3 Translate で、PLaMo Community License に従います。画面には「Built with PLaMo」と出します。ライセンスの本文は拡張機能に同梱しており、初回の画面で説明したうえで、同意したことを記録します。

## 拡張機能が読むもの

ページ、選択範囲、または拡張機能のテキスト入力ページに入力した文字の翻訳を頼んだとき、あるいは自動翻訳をオンにしたサイトでは、翻訳する文字と、入力済みの設定を読みます。

その文字は、訳文を作るためだけに使います。既定では端末の中で処理します。設定でローカルサーバーを選んだときは、同じ文字を設定したアドレスにだけ送ります。

スキャンしたPDFで利用できるテキスト層がないページは、そのページを描画して PP-OCRv6 で端末内文字認識を行います。利用できるテキスト層があるページでは OCR を実行しません。画像の右クリックメニューで「画像を翻訳」を選んだときも、画像のピクセルを端末内で読みます。最初に既存の canvas データまたは匿名 CORS での読み取りを試し、失敗した場合はそのクリックによる一度だけの activeTab 許可で表示中のタブをキャプチャし、画像の領域だけを切り出します。画像配信元のホスト権限は追加せず、OCR のピクセルと認識した文字をアップロードすることもありません。

PDF を拡張機能のリーダーで開いたときは、ページの文字ではなく PDF ファイルそのものを読みます。Chrome は PDF を専用のビューアで描くため、拡張機能からは本文を読めないからです。ファイルは、そのタブがすでに表示しているアドレスから一度だけ、そのタブがすでに持っている Cookie 付きで取得し、端末の拡張機能の中に保存し、リーダーのタブを閉じたときに削除します。リーダーを再読み込みするとそのコピーは消えるので、元の PDF のタブ（またはファイルの選択）から開き直します。タブが閉じたことを伝えられなかった残りは、1日以内に消します。どこかへ送ることはありません。

## 収集しないもの

開発者は、ページの本文、選択範囲、用語集、訳文を受け取りません。アカウントは作りません。拡張機能に広告、分析、テレメトリ、クラッシュ報告はありません。データを販売することも、利用者のプロフィールを作ることに使うこともありません。

## 翻訳のしくみ

PLaMo 3 Translate は、拡張機能の中で、端末上で動きます。モデルのファイルは拡張機能に同梱しておらず、最初に必要になったときに Hugging Face から取得して端末に保存します。そのあとは、PLaMo の翻訳に通信は要りません。Chrome や Edge など Chromium 系ブラウザの初回は、このパソコン上の共有フォルダが選ばれています。ブラウザ内保存も選べます。Firefox はモデルをブラウザ内に保存し、共有フォルダにある公式モデルを一度だけコピーできます。コピーは使用前に検証します。フォルダもブラウザー内のコピーも端末の中にあり、どこかへ送ることはありません。

PP-OCRv6 は、スキャンPDFと画像の OCR のために拡張機能の中で端末上で動きます。検出・認識モデルの重みは同梱しておらず、利用者が選んだときにだけ Hugging Face から取得します。初回設定で翻訳モデルと一緒に取得するか、あとから設定画面で取得できます。OCR 機能を使っても自動的にはダウンロードしません。重みがない場合は、設定画面からインストールするよう案内します。ONNX Runtime Web の WASM と文字辞書は同梱しています。モデルがインストールされたあとは OCR に通信は要りません。

Chrome では、PLaMo が対応していない言語の組み合わせに Chrome 内蔵の翻訳を使います。これも端末の中で動きます。その言語の言語パックは Chrome 自身が取得します。ページが言語を示していないときは、Chrome 内蔵の言語判定が、ページの文字の一部を見ることがあります。いずれも端末上で動く Chrome の機能です。この拡張機能が開発者や Preferred Networks へ送るものではありません。

Firefox ではそれらの Chrome の機能は使いません。PLaMo が対応する言語の組み合わせだけを訳します。

設定で、PLaMo のリクエストを内蔵エンジンから、自分で起動した実験的な OpenAI 互換のローカルサーバー（mlx_lm.server など）へ切り替えられます。この経路の翻訳精度は保証しません。そのサーバーを運営するのは開発者ではありません。文字は入力した URL にだけ送ります。既定はこの端末（`127.0.0.1` / `localhost`）です。この端末ではない URL は、本文が端末の外へ出る旨の警告を確認するまで送りません。

## ダウンロードと、それを見られる範囲

内蔵エンジンについての、この拡張機能自身が行う通信は、Hugging Face からの PLaMo と PP-OCRv6 のモデルの取得です。Hugging Face と、ファイルを配信するネットワークには、IP アドレスと、モデルのファイルが要求されたことが伝わります。ページの本文、選択範囲、用語集、訳文は伝わりません。

PDF を開くときは、その PDF のタブがすでに表示しているサイトへ 1 回だけ、同じアドレスを、そのタブがすでに持っている Cookie 付きで要求します。そのサイトは元々そのファイルを配信しているので、この要求で新たに分かることはありません。拡張機能はパラメータを足さず、本文も送りません。取得したファイルを開発者や他のサーバーへ渡すこともありません。

ローカルサーバーを有効にすると、設定したアドレスへ翻訳リクエストも送ります。そのプロセスは翻訳する文字を見られます。開発者は受け取りません。

Chrome ウェブストアまたは addons.mozilla.org から入れた場合、ブラウザが拡張機能を更新することがあります。それはブラウザ自身の通信で、この拡張機能が行うものではありません。

## 端末に保存するもの

拡張機能は、次のものを端末に保存し、開発者へは送りません。

- 翻訳先の言語や文体などの設定
- 用語集とサイトごとの規則
- ライセンスに同意したことの記録
- PLaMo と OCR のモデルファイル（ブラウザ内、または Chrome や Edge など Chromium 系ブラウザでは、このパソコン上で選んだフォルダ）。共有フォルダを選ぶと検証済みのブラウザ内コピーをフォルダへ移動し、ブラウザ内保存に戻すとフォルダのファイルを消さずにブラウザ内へコピーします
- 翻訳キャッシュ（同じ文章を二度訳さずに済ませるための、端末内の保存）
- 任意のローカルサーバー API キー（chrome.storage.local に平文で保存します）
- リーダーで開いた PDF の写し（そのタブを閉じるまで。残りは1日以内に消します）

翻訳モデルと OCR モデルの削除、翻訳キャッシュの消去は、拡張機能の設定画面から行えます。共有フォルダの使用をやめても、そのフォルダのファイルは消えません。拡張機能を削除すると、ブラウザ内に残していたものは消えます。

## 翻訳しない文字

入力欄に入力中の文字は翻訳しないようにしています。入力中の欄の中で選択した範囲も対象外です。通常の本文は翻訳するため、個人に関する記述が本文に含まれていれば、その部分も翻訳されます。

## 権限

インストールした時点で、すべてのサイトへのアクセスが与えられるわけではありません。リリース版ではインストール時のホストアクセスを要求しません。画像翻訳でもホスト権限は追加せず、captureVisibleTab による予備の取得では、画像の右クリックメニューを選んだときの activeTab 許可だけを使います。今開いているタブの一回だけの翻訳には、その操作に対してブラウザが与えるアクセスを使います。特定のサイトへのアクセスは任意で、そのサイトの自動翻訳をオンにしたとき、動画字幕翻訳をオンにしたとき（YouTube と X）、独自の字幕サイトを追加したとき、または Gmail / Outlook のメッセージバナーをポップアップか設定から有効にしたときに要求します。すべてのサイトの選択がオンのときは、その1回の許可でこれらのサイトもまかなわれ、追加の確認は表示されません。すべてのサイトを選ぶ任意の設定もあり、既定ではオフです。これをオンにすると http/https ページへの任意のアクセスが一度だけ許可され、選択翻訳のボタンとショートカットがページの読み込み時から使えるようになります。サイトごとの操作は不要です。同じ設定をオフにするか、ブラウザーの拡張機能の権限設定から取り消せます。この設定がするのは拡張機能の content script をページで動かすことだけです。ページの本文がどこかに送られることはなく、このポリシーの他の部分と同じく、ローカルサーバーを設定しない限り翻訳は端末の中で行われます。ローカルサーバーへのアクセスも任意です。そのエンジンをオンにしたときやループバックのアドレスを変えたときに要求し、この端末ではない URL では警告のチェックを確認したあとで要求します。

## 限定的な利用

拡張機能の目的は、ウェブページを翻訳するという一つだけです。読み取った文字、サイトごとの規則、用語集は、その目的にだけ使います。販売せず、広告に使わず、信用や適格性の判断にも使わず、開発者が読むこともありません。拡張機能は Google API から利用者データを受け取りません。

## 連絡先

このポリシーについての質問は、https://github.com/jammaru/sakutto/issues の issue で受けます。ソースコードは https://github.com/jammaru/sakutto に、Chrome ウェブストアの掲載は https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl にあります。
