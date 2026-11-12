# Sakutto

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/mhlbjjijfkoghmcjndgdimhdlfkhadfl?logo=googlechrome&logoColor=white&label=Chrome%20Web%20Store)](https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl)
[![Chrome Web Store users](https://img.shields.io/chrome-web-store/users/mhlbjjijfkoghmcjndgdimhdlfkhadfl?label=users)](https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl)
[![GitHub stars](https://img.shields.io/github/stars/jammaru/sakutto?style=flat&logo=github)](https://github.com/jammaru/sakutto/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/pdSRBaSr38)
[![Last commit](https://img.shields.io/github/last-commit/jammaru/sakutto)](https://github.com/jammaru/sakutto/commits/main)

Sakutto は、ウェブページを端末の中で翻訳する、Chrome と Firefox 向けの非公式の拡張機能です。翻訳には [PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF) を使い、実行にはピン留めした [wllama](https://github.com/ngxson/wllama) を使います。訳文はすべて PLaMo が生成します。モデルの準備を待つあいだも、ページには Chrome 内蔵翻訳の下書きを挟まず、原文のまま表示します。Chrome の Translator API を使うのは、PLaMo が対応していない言語の組み合わせだけです。Firefox では PLaMo だけを使います。Preferred Networks, Inc. とは無関係です。Built with PLaMo。

この拡張機能は無料のオープンソース（MIT）です。広告も有料機能もありません。モデルの重みは、このリポジトリにも拡張パッケージにも含まれません。

## インストール

Chrome ウェブストアからインストールできます。

https://chrome.google.com/webstore/detail/mhlbjjijfkoghmcjndgdimhdlfkhadfl

自分でビルドして読み込む場合は、次の手順です。

1. Node.js 24 と pnpm 12 を用意します。
2. このリポジトリを取得し、`pnpm install` を実行します。
3. [ビルド](#ビルド) の手順で、翻訳ランタイムと拡張機能をビルドします。
4. Chrome: `chrome://extensions` を開き、**デベロッパー モード** をオンにし、**パッケージ化されていない拡張機能を読み込む** から `.output/chrome-mv3` を選びます。
5. Firefox 153 以降（まずは Windows）: `about:debugging` の「この Firefox」から **一時的なアドオンを読み込む** で `.output/firefox-mv3/manifest.json` を選びます。[docs/FIREFOX.md](docs/FIREFOX.md) を参照してください。

## ショートカット

| 操作                                     | Windows / Linux                 | Mac                                    |
| ---------------------------------------- | ------------------------------- | -------------------------------------- |
| ページを翻訳する、または原文に戻す       | Alt+A（Firefox は Alt+Shift+A） | Option (⌥)+A（Firefox は Alt+Shift+A） |
| 置換表示と対訳表示を切り替える           | Alt+B（Firefox は Alt+Shift+B） | Option (⌥)+B（Firefox は Alt+Shift+B） |
| 選択範囲を翻訳する                       | Alt+S（Firefox は Alt+Shift+S） | Option (⌥)+S（Firefox は Alt+Shift+S） |
| 入力中のテキストを翻訳する               | Alt+T（Firefox は Alt+Shift+T） | Option (⌥)+T（Firefox は Alt+Shift+T） |
| PDF をリーダーで開く                     | 未設定（任意で割り当て）        | 未設定                                 |
| 入力したテキストを翻訳する（専用ページ） | Ctrl+Enter                      | ⌘+Enter                                |

ツールバーのポップアップと、右クリックメニューからも同じ操作ができます。キーは Chrome が管理しているため、設定画面の「キーボードショートカット」か、ポップアップの「ショートカットキーを変更」から `chrome://extensions/shortcuts` を開いて変更します。Firefox の初期キーは Alt+Shift+文字で、Windows のメニューと重ならないようにしてあります。「ショートカットキーを変更」は Firefox 自身の設定を開きます。変更すると、ポップアップに並ぶキーの表示もその場で切り替わります。Chrome が割り当てたキーは、入力欄にフォーカスがあっても拡張機能コマンドとして届き、ページは翻訳されます。一度も割り当てられなかったコマンドは、ページ上で既定キーを扱います。keydown はテキストエリアにも届き、Sakutto は preventDefault しないので Option+文字はそのまま入力できます。`chrome://` や PDF ビューアではコンテンツスクリプトが動かないため、このページ内の既定は使えません。Chrome の編集画面で消したキーはオフのままです。インストール時から未設定だった既存の導入では、ページ内の既定が使えます。拡張機能のショートカットの Alt は、Mac の Chrome では Option として扱われるため、文字は同じです。同じフォルダから unpacked を読み直すと、Chrome の編集画面では以前消した割り当てが残ることがあります。Alt+D は Windows と Linux の Chrome がアドレスバーに使うため、既定では使いません。

## 入力したテキストの翻訳

メッセージ欄やテキストエリアなど、入力中の欄にフォーカスがあるとき、Alt+T（Mac では Option+T、Firefox では Alt+Shift+T）か欄の近くの「あA」ボタンで入力中の文の訳をプレビューできます。同じショートカットをもう一度押すか、Ctrl+Enter（Mac では ⌘+Enter）で置き換えます。「元に戻す」で下書きに戻せます。プレビューで訳先を選べます。設定でプレビューを省略し、ショートカット一回で翻訳して置き換えることもできます。日本語の下書きは英語へ（訳先が日本語以外ならその言語へ）、それ以外は設定した訳先へ訳します。パスワード欄と、このサイトを翻訳しない設定のページは対象外です。「あA」ボタンは設定で非表示にできます。Chrome が割り当てたページ用ショートカットは、入力欄からでもページを翻訳します（`onCommand`）。未割り当ての既定キーの keydown は欄にも届きますが、Sakutto は握らないので Option+文字は入力できます。入力中の翻訳ショートカットは欄の中でも使えます。ページ翻訳と同じ PLaMo のモデルを使い、Chrome の内蔵翻訳は使いません。

ポップアップに「テキストを翻訳」、設定画面にも同じボタンがあります。開く小さな拡張機能ページに入力欄と訳文欄があり、ページを選ばずに段落を入力・貼り付けて翻訳できます。ページ翻訳と同じ PLaMo のモデル、同じライセンスへの同意、同じ読み込み手順を使い、翻訳の向きも同じ翻訳先言語の設定に従います。Chrome の内蔵翻訳は使いません。入力したテキストは PLaMo だけで翻訳し、PLaMo が対応しない言語を選んだときは、裏で Chrome に渡さずにその場で断ります。訳文にはコピーのボタンがあります。

## PDF の翻訳

Chrome は PDF を専用のビューアで描くため、ページ翻訳をその本文に当てることはできません。代わりに Sakutto が PDF を自分で読みます。PDF を開いているとき、ポップアップに「この PDF を翻訳」が出ます（右クリックメニューにも同じ項目があります）。タブが表示しているファイルをそのまま取得し、拡張機能のリーダーを新しいタブで開いて、そこで翻訳します。Chrome が既定のキーを持てるコマンドは 4 つまでで、ページ操作用の 4 つがそれを使い切っているため、PDF を開く操作には既定のキーがありません。キーが欲しい場合はブラウザのショートカット設定で割り当ててください。

リーダーはページの見た目をそのまま残します。各ページは pdf.js で一度描き、訳文は元の文字が占めていた枠の中に置きます。2 段組の論文は 2 段組のまま、表の数字は見出しの下のまま、図のキャプションは図の下のままになります。訳文が元より長いブロックは横と下の空きへ伸び、次のブロックや図で止まり、それでも入らないときだけ文字を小さくします（元の大きさのおよそ 67% を下限とし、本文は 6pt、それ以外は 6.5pt 未満にはしません）。それでも収まらないブロックは、途中で切った訳文を出さず、原文の組版のまま残し、印を開くと全文の訳を読めます。1 ページ目の氏名・所属・メールは原文の表記のまま残します。

リーダーは、いま見ているページを先に、残りは見えたときに翻訳します。40 ページの報告書を 30 ページ目から開いても、前の 29 ページを待たされません。テキスト層のない PDF（スキャンや画像だけのページ）は表示し、翻訳できる文字がないことを伝えます。画像だけのページを文字起こししてから訳すことはしません。推測した文字を原文として訳すのは、画像のまま残すより悪い結果になります。

PDF がダウンロードフォルダに保存されることはありません。ファイルはタブが表示しているサイトから、そのタブがすでに持っている Cookie 付きで取得し、拡張機能の中に保存し、リーダーのタブを閉じると削除します。リーダーを再読み込みするとそのコピーは消えるので、元の PDF のタブ（またはファイルの選択）から開き直します。落ちたときの残りは 1 日以内に消します。

## 対応言語

PLaMo 3 Translate は 53 言語を双方向に翻訳します。訳元はページから判定します。訳先の既定は、ブラウザの表示言語です。表示言語が 53 言語にないときは英語になります。ポップアップでは、今開いているサイトの訳先を変えられます。

cs、da、el、fi、kn、no、pt、ro、sv、tr、uk の 11 言語は、Chrome 内蔵の翻訳だけで訳します。Firefox ではこれらの訳先は出しません。PLaMo が対応する言語は、モデルの準備ができるまで訳しません。

画面の文言は、英語、日本語、韓国語、中国語（簡体字・繁体字）、スペイン語、ポルトガル語（ブラジル）、フランス語、ドイツ語、イタリア語、ロシア語、ベトナム語、タイ語、インドネシア語の 14 言語にあります。ブラウザの表示言語に合わせて選ばれ、どれにも当たらないときは英語になります。追加の方法は [docs/TRANSLATING.ja.md](docs/TRANSLATING.ja.md) にあります。

## プライバシー

既定では翻訳は端末の中で行います。ページの本文、選択範囲、用語集、訳文を開発者へ送ることはありません。アカウント、広告、テレメトリもありません。内蔵エンジンについての拡張機能自身の通信は、Hugging Face からのモデルの取得と、PDF のときはタブが表示しているサイトからのファイル取得です。設定で **実験的なローカルサーバー**（mlx_lm.server、LM Studio など、この端末上の OpenAI 互換プロセス）をオンにすると、翻訳する文字は設定したアドレスにだけ送ります。開発者は受け取りません。精度は保証しません。ポリシーは [PRIVACY.md](PRIVACY.md) と https://jammaru.com/sakutto/privacy/ にあります。

## ローカルサーバー（実験的）

既定のエンジンは同梱の wllama（WebGPU または CPU）です。設定で、PLaMo のリクエストをこの端末の OpenAI 互換サーバーへ向けられます。実験的機能です。翻訳の精度は保証せず、内蔵エンジンと訳が異なり、誤訳が出ることがあります。Mac での確認では MLX 4bit / 8bit / bf16 のいずれも、内蔵エンジンにはない誤訳が出ました。原因は量子化の数値で、リクエストの差ではありません。Sakutto の PFML3 プロンプトを raw の `/v1/completions` に送ります。chat completions は使いません。手順の例:

- `mlx_lm.server` — 既定 `http://127.0.0.1:8080/v1`。PLaMo の MLX-4bit は [PLaMo 3 Translate のコレクション](https://huggingface.co/collections/pfnet/plamo-3-translate)
- LM Studio — 既定 `http://127.0.0.1:1234/v1`

LM Studio ではサーバー側のサンプラーを温度 0 / greedy にしてください。プロンプトの一致は `mlx_lm.server` と PLaMo の `serve.py` を基準にしています。LM Studio の BOS の扱いは未確認です。

設計、モデル、Linux では測っていないこと: [docs/design/mlx-backend.md](docs/design/mlx-backend.md)。Mac での計測: [bench/README.md](bench/README.md)。

## ビルド

```bash
pnpm install
pnpm build:wllama   # Docker が必要です。docs/BUILDING.md を参照
pnpm verify:wllama
pnpm build          # 成果物は .output/chrome-mv3
pnpm build:firefox  # Firefox 153 以降向け。成果物は .output/firefox-mv3
pnpm zip            # Chrome ウェブストア用の zip は .output
pnpm zip:firefox    # Firefox 用 zip。.output へ。AMO のソース zip は pnpm source:firefox
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

## PDF の確認

`bench/pdf/paper.html` はこのリポジトリ向けに書いた 2 段組の原稿で、`scripts/bench/build-pdf-fixtures.ts` がそれを `bench/pdf/paper.pdf` に印刷します（フォントのサブセット、グリフ位置、表と図を持つテキスト層）。同じ組版をページごとのビットマップにした、テキスト層のない `bench/pdf/scan.pdf` も作ります。どちらも自分たちの文なので、小さく、MIT のままコミットできます。

組版の品質は 2 段階で見ます。

- **速い確認（CI）。** `pnpm test` は合成ページ（2 段組の本文、ディスプレイ数式、図中の語と軸目盛、表、コード、柱・ノンブル、画像だけのページ）を、リーダーと同じ切り出し・収め・重なりの規則に通し、日本語のように伸びる決定的なスタブ翻訳器を使います。モデルは読みません。`pnpm bench:pdf:layout` は同じ経路をコミット済みの PDF に走らせます。数秒で終わる想定です。
- **遅い確認（モデルあり）。** `pnpm bench:pdf` はビルドした拡張機能を読み、本物の `pdf:open` 経路でフィクスチャを開き、PLaMo で訳します。`--pages N` で長いファイルを切り、`--shot-page N` で 1 ページのスクリーンショットを撮り、`--keep-cache` でプロファイル内の訳を再利用します。

```bash
pnpm test                 # 組版だけの PDF 検査を含む
pnpm bench:pdf:layout     # コミット済み PDF、スタブ翻訳、モデルなし
pnpm bench:build:live     # 実モデルのベンチが読むビルド
pnpm bench:pdf            # 8 スレッド、実モデル
pnpm bench:pdf --threads 4
pnpm bench:pdf --page scan   # ビットマップのフィクスチャ。文字なしと出ること
pnpm bench:pdf --keep-cache  # プロファイルに残った訳を再利用
```

**モデルは一度だけ。** `bench/.cache/pdf-profile` が拡張機能の保存内容を保持するので、546 MB のモデルは初回だけ取得し、以降はディスクから読みます。拡張機能は毎回 `bench/.cache/ext-live` に置きます。unpacked の ID はパスから決まり、その ID で私有ファイルシステムが分かれるため、別パスから読むとプロファイルにモデルのコピーが増えます。実行結果はコピー数を出し、2 つ以上なら警告します。何もないところからやり直すときはプロファイルのディレクトリを消します。

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
