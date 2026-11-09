# Sakutto

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/mhlbjjijfkoghmcjndgdimhdlfkhadfl?logo=googlechrome&logoColor=white&label=Chrome%20Web%20Store)](https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl)
[![Chrome Web Store users](https://img.shields.io/chrome-web-store/users/mhlbjjijfkoghmcjndgdimhdlfkhadfl?label=users)](https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl)
[![GitHub stars](https://img.shields.io/github/stars/jammaru/sakutto?style=flat&logo=github)](https://github.com/jammaru/sakutto/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/pdSRBaSr38)
[![Last commit](https://img.shields.io/github/last-commit/jammaru/sakutto)](https://github.com/jammaru/sakutto/commits/main)

Sakutto は、ウェブページを端末の中で翻訳する非公式の Chrome 拡張機能です。翻訳には [PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF) を使い、実行にはピン留めした [wllama](https://github.com/ngxson/wllama) を使います。訳文はすべて PLaMo が生成します。モデルの準備を待つあいだも、ページには Chrome 内蔵翻訳の下書きを挟まず、原文のまま表示します。Chrome の Translator API を使うのは、PLaMo が対応していない言語の組み合わせだけです。Preferred Networks, Inc. とは無関係です。Built with PLaMo。

この拡張機能は無料のオープンソース（MIT）です。広告も有料機能もありません。モデルの重みは、このリポジトリにも拡張パッケージにも含まれません。

## インストール

Chrome ウェブストアからインストールできます。

https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl

自分でビルドして読み込む場合は、次の手順です。

1. Node.js 24 と pnpm 12 を用意します。
2. このリポジトリを取得し、`pnpm install` を実行します。
3. [ビルド](#ビルド) の手順で、翻訳ランタイムと拡張機能をビルドします。
4. `chrome://extensions` を開きます。
5. **デベロッパー モード** をオンにします。
6. **パッケージ化されていない拡張機能を読み込む** を選びます。
7. このリポジトリの `.output/chrome-mv3` を選択します。

## ショートカット

| 操作                                     | Windows / Linux | Mac          |
| ---------------------------------------- | --------------- | ------------ |
| ページを翻訳する、または原文に戻す       | Alt+A           | Option (⌥)+A |
| 置換表示と対訳表示を切り替える           | Alt+B           | Option (⌥)+B |
| 選択範囲を翻訳する                       | Alt+S           | Option (⌥)+S |
| 入力中のテキストを翻訳する               | Alt+T           | Option (⌥)+T |
| 入力したテキストを翻訳する（専用ページ） | Ctrl+Enter      | ⌘+Enter      |

ツールバーのポップアップと、右クリックメニューからも同じ操作ができます。キーは Chrome が管理しているため、設定画面の「キーボードショートカット」か、ポップアップの「ショートカットキーを変更」から `chrome://extensions/shortcuts` を開いて変更します。変更すると、ポップアップに並ぶキーの表示もその場で切り替わります。そこでキーを消すと、Sakutto でもそのショートカットは使いません。インストール時に Chrome がキーを割り当てられなかった場合（他の拡張機能との競合など）は、設定でオフにするまでページ上では既定のキーが使えます。拡張機能のショートカットの Alt は、Mac の Chrome では Option として扱われるため、文字は同じです。Alt+D は Windows と Linux の Chrome がアドレスバーに使うため、既定では使いません。

## 入力したテキストの翻訳

メッセージ欄やテキストエリアなど、入力中の欄にフォーカスがあるとき、Alt+T（Mac では Option+T）か欄の近くの「あA」ボタンで入力中の文の訳をプレビューできます。同じショートカットをもう一度押すか、Ctrl+Enter（Mac では ⌘+Enter）で置き換えます。「元に戻す」で下書きに戻せます。プレビューで訳先を選べます。設定でプレビューを省略し、ショートカット一回で翻訳して置き換えることもできます。日本語の下書きは英語へ（訳先が日本語以外ならその言語へ）、それ以外は設定した訳先へ訳します。パスワード欄と、このサイトを翻訳しない設定のページは対象外です。「あA」ボタンは設定で非表示にできます。インストール時に Chrome が Alt+T を割り当てなかった場合は、ページ上では既定のキーが使えます。Chrome のショートカット設定でキーを消すとオフになります。ページ翻訳と同じ PLaMo のモデルを使い、Chrome の内蔵翻訳は使いません。

ポップアップに「テキストを翻訳」、設定画面にも同じボタンがあります。開く小さな拡張機能ページに入力欄と訳文欄があり、ページを選ばずに段落を入力・貼り付けて翻訳できます。ページ翻訳と同じ PLaMo のモデル、同じライセンスへの同意、同じ読み込み手順を使い、翻訳の向きも同じ翻訳先言語の設定に従います。Chrome の内蔵翻訳は使いません。入力したテキストは PLaMo だけで翻訳し、PLaMo が対応しない言語を選んだときは、裏で Chrome に渡さずにその場で断ります。訳文にはコピーのボタンがあります。

## 対応言語

PLaMo 3 Translate は 53 言語を双方向に翻訳します。訳元はページから判定します。訳先の既定は、ブラウザの表示言語です。表示言語が 53 言語にないときは英語になります。ポップアップでは、今開いているサイトの訳先を変えられます。

cs、da、el、fi、kn、no、pt、ro、sv、tr、uk の 11 言語は、Chrome 内蔵の翻訳だけで訳します。PLaMo だけが対応する言語は、モデルの準備ができるまで訳しません。

画面の文言は、英語、日本語、韓国語、中国語（簡体字・繁体字）、スペイン語、ポルトガル語（ブラジル）、フランス語、ドイツ語、イタリア語、ロシア語、ベトナム語、タイ語、インドネシア語の 14 言語にあります。ブラウザの表示言語に合わせて選ばれ、どれにも当たらないときは英語になります。追加の方法は [docs/TRANSLATING.ja.md](docs/TRANSLATING.ja.md) にあります。

## プライバシー

翻訳は端末の中で行います。ページの本文、選択範囲、用語集、訳文を、開発者や翻訳サーバーへ送ることはありません。アカウント、広告、テレメトリもありません。拡張機能自身の通信は、Hugging Face からのモデルの取得だけです。ポリシーは [PRIVACY.md](PRIVACY.md) と https://jammaru.com/sakutto/privacy/ にあります。

## ビルド

```bash
pnpm install
pnpm build:wllama   # Docker が必要です。docs/BUILDING.md を参照
pnpm verify:wllama
pnpm build          # 成果物は .output/chrome-mv3
pnpm zip            # Chrome ウェブストア用の zip は .output
```

`pnpm build:wllama` は、ピン留めした wllama のコミット `d275dac` を `emscripten/emsdk:4.0.20` コンテナの中でコンパイルします。wasm、worker、モデルの重みはコミットしません。`pnpm build` と `pnpm zip` は、そのビルドを検証できるまで失敗します。`pnpm zip` は、パッケージにランタイムとライセンス文が入っていること、モデルの重みやソースマップ、インストール時のホスト権限が入っていないことを確認します。

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e       # ローカルのページで確認します。モデルはダウンロードしません
```

`pnpm test:e2e` は、ページ内で翻訳するテスト用パッケージをビルドします。これはリリース用のビルドではありません。リリース用のビルドに、テスト用の翻訳処理は入りません。

`pnpm bench:mock` と `pnpm bench:live` は、読者が実際に待つ時間をページ単位で測ります。[bench/pages](bench/pages) の 8 つのページは、それぞれ別のコストを切り出しています（長い記事、先頭の 1 段落と長い残り、短いカードの多数、非常に長い 1 段落、サイドバー、混在する UI、記事ヘッダー内の見出し、後から差し込まれる内容）。実行するたびに `bench/history/pages.jsonl` に追記されるので、後のコミットを同じページで前のコミットと比べられます。`pnpm bench:serve` を使うと、そのページを自分のブラウザで開けます。指標、モックと実モデルの違い、ページの追加方法は [bench/README.md](bench/README.md) にあります。

`pnpm icons` は、`scripts/generate-icons.mjs` から PNG アイコンを作り直します。

`pnpm i18n:check` は、`public/_locales` の全カタログを英語と突き合わせ、キー・`$TOKEN$`・空の文言を検査します。`pnpm i18n:draft <カタログ> <言語>` は、同梱しているのと同じ PLaMo で英語から下書きを作ります。どちらも [docs/TRANSLATING.ja.md](docs/TRANSLATING.ja.md) にあります。

## 権限

| 権限               | 理由                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `storage`          | 訳先の言語、表示、その他の設定を保存します。                               |
| `unlimitedStorage` | ダウンロードしたモデルと翻訳キャッシュを端末に保持します。                 |
| `offscreen`        | Service Worker より長く生きる文書で、翻訳ランタイムを動かします。          |
| `activeTab`        | ポップアップを開いたときやコマンドを実行したときに、今のページを読みます。 |
| `scripting`        | 翻訳を依頼したタブに content script を注入します。                         |
| `contextMenus`     | 右クリックメニューに「ページを翻訳」「選択範囲を翻訳」を追加します。       |

サイトごとの自動翻訳をオンにしたときだけ、`https://*/*` と `http://*/*` の任意ホスト権限を要求します。インストール時に、すべてのサイトへの権限は要求しません。

## 支援

Sakutto にマネタイズポイントはありません。完全無料で、広告も有料機能もありません。

そもそも自分がこういう翻訳拡張機能を欲しいと思って作り始めたもので、ありがたいことに思った以上に需要がありそうだったので公開しました。今後も有料化や広告の導入は考えていません。

ただ、継続的に開発していくには時間もコストもかかるので、今回 GitHub Sponsors を開設しました。もし Sakutto を気に入っていただけたら、開発を支援していただけると嬉しいです。

- **月 5 ドル（Supporter）**: Sakutto の継続的な開発を応援していただくプランです。
- **月 10 ドル（Backer）**: さらに応援していただける方向けのプランです。支援額による機能の違いはありません。
- **1 回のみ**: 継続的な支払いが不要な場合は、任意の金額を 1 回だけ送れます。

どちらのプランも限定機能や優先サポートはありません。いただいた支援は、新機能の追加や翻訳品質・速度の改善、継続的なメンテナンスに役立てます。もちろん、支援の有無に関係なく、これからも完全無料で使える OSS として開発を続けていきます。https://github.com/sponsors/jammaru

## 貢献

まず [Issue](https://github.com/jammaru/sakutto/issues) を開き、できるならその Issue への pull request を出してください。その順を歓迎します。PR はとても欲しいですが、Issue だけでも十分です。フォームを使い、非公開ページの本文は貼らないでください。使い方の質問は [Discord](https://discord.gg/pdSRBaSr38) の方が早いことがあります。

- [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)（English: [CONTRIBUTING.md](CONTRIBUTING.md)）
- [行動規範](CODE_OF_CONDUCT.ja.md)
- [SECURITY.md](SECURITY.md)

## ライセンス

- このリポジトリのコードは MIT です。[LICENSE](LICENSE) を参照してください。Copyright 2026 jammaru。- PLaMo 3 Translate は PLaMo Community License です。全文は `licenses/PLaMo-Community-License-ja.txt` と `licenses/PLaMo-Community-License-en.txt` にあり、拡張パッケージにも同じ写しを同梱します。個人利用と学術利用は登録が不要です。第3条により、モデルのライセンスで商業利用が認められるのは、PFN のフォーム（https://forms.gle/mTL8tBLrMYXKNZD56）への事前登録と、利用者または関係会社の直近事業年度の収入・売上が10億円以下であることの両方を満たす場合だけです。満たさない場合、商業利用には PFN の商業用ライセンスが必要です。このリポジトリの MIT は Sakutto 自身のコードに対するもので、モデルの重みは対象ではありません。
- llama.cpp、wllama、Emscripten、Dawn の WebGPU ライブラリ、Svelte については [NOTICE](NOTICE) と [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
- `scripts/bench/fixtures/kyoto.html` は CC BY-SA 4.0 の Wikipedia 二次的著作物です。MIT の対象ではなく、拡張パッケージにも含めません。

English documentation: [README.md](README.md).
