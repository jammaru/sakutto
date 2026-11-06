# Sakutto

Sakutto は、ウェブページを端末の中で翻訳する非公式の Chrome 拡張機能です。翻訳には [PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF) を使い、実行にはピン留めした [wllama](https://github.com/ngxson/wllama) を使います。訳文はすべて PLaMo が生成します。モデルの準備を待つあいだも、ページには Chrome 内蔵翻訳の下書きを挟まず、原文のまま表示します。Chrome の Translator API を使うのは、PLaMo が対応していない言語の組み合わせだけです。Preferred Networks, Inc. とは無関係です。Built with PLaMo。

この拡張機能は無料のオープンソース（MIT）です。広告も有料機能もありません。モデルの重みは、このリポジトリにも拡張パッケージにも含まれません。

## インストール

Chrome ウェブストアの掲載は、まだ公開していません。公開までは、ソースからインストールしてください。

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
| 入力したテキストを翻訳する（専用ページ） | Ctrl+Enter      | ⌘+Enter      |

ツールバーのポップアップと、右クリックメニューからも同じ操作ができます。キーは `chrome://extensions/shortcuts` で変更できます。拡張機能のショートカットの Alt は、Mac の Chrome では Option として扱われるため、文字は同じです。Alt+D は Windows と Linux の Chrome がアドレスバーに使うため、使いません。

## 入力したテキストの翻訳

ポップアップに「テキストを翻訳」、設定画面にも同じボタンがあります。開く小さな拡張機能ページに入力欄と訳文欄があり、ページを選ばずに段落を入力・貼り付けて翻訳できます。ページ翻訳と同じ PLaMo のモデル、同じライセンスへの同意、同じ読み込み手順を使い、翻訳の向きも同じ翻訳先言語の設定に従います。Chrome の内蔵翻訳は使いません。入力したテキストは PLaMo だけで翻訳し、PLaMo が対応しない言語を選んだときは、裏で Chrome に渡さずにその場で断ります。訳文にはコピーのボタンがあります。

## 対応言語

PLaMo 3 Translate は 53 言語を双方向に翻訳します。訳元はページから判定します。訳先の既定は、ブラウザの表示言語です。表示言語が 53 言語にないときは英語になります。ポップアップでは、今開いているサイトの訳先を変えられます。

cs、da、el、fi、kn、no、pt、ro、sv、tr、uk の 11 言語は、Chrome 内蔵の翻訳だけで訳します。PLaMo だけが対応する言語は、モデルの準備ができるまで訳しません。

## プライバシー

この拡張機能はページの本文をサーバーへ送らず、テレメトリもありません。拡張機能自身の通信はモデルのダウンロードで、`huggingface.co` から始まり、Hugging Face の CDN へ転送されます。その通信に載るのはファイルの要求と接続の情報であり、ページの本文ではありません。Chrome が内蔵翻訳の言語パックを別にダウンロードすることがあります。PLaMo での翻訳が通信なしで行えるのは、検査済みのモデルが端末に保存されたあとです。Chrome への切替は、その言語パックが既にあるときに限られます。詳細は [PRIVACY.md](PRIVACY.md) にあります。

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

## ライセンス

- このリポジトリのコードは MIT です。[LICENSE](LICENSE) を参照してください。Copyright 2026 jammaru。
- PLaMo 3 Translate は PLaMo Community License です。全文は `licenses/PLaMo-Community-License-ja.txt` と `licenses/PLaMo-Community-License-en.txt` にあり、拡張パッケージにも同じ写しを同梱します。個人利用と学術利用は登録が不要です。第3条により、モデルのライセンスで商業利用が認められるのは、PFN のフォーム（https://forms.gle/mTL8tBLrMYXKNZD56）への事前登録と、利用者または関係会社の直近事業年度の収入・売上が10億円以下であることの両方を満たす場合だけです。満たさない場合、商業利用には PFN の商業用ライセンスが必要です。このリポジトリの MIT は Sakutto 自身のコードに対するもので、モデルの重みは対象ではありません。
- llama.cpp、wllama、Emscripten、Dawn の WebGPU ライブラリ、Svelte については [NOTICE](NOTICE) と [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
- `scripts/bench/fixtures/kyoto.html` は CC BY-SA 4.0 の Wikipedia 二次的著作物です。MIT の対象ではなく、拡張パッケージにも含めません。

English documentation: [README.md](README.md).
