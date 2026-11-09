# 貢献

English: [CONTRIBUTING.md](CONTRIBUTING.md)

Sakutto は MIT です。[LICENSE](LICENSE) と [NOTICE](NOTICE) を参照してください。[行動規範](CODE_OF_CONDUCT.ja.md) に従ってください。

まず [Issue](https://github.com/jammaru/sakutto/issues) を開き、その Issue に対して pull request を出す、という順を歓迎します。できるなら PR をとても歓迎します。Issue だけでも十分です。コードを書かなくても構いません。小さな PR で足ります。誤字、1 つの言語、ドキュメント、範囲の狭い修正で構いません。

使い方の質問は [Discord](https://discord.gg/pdSRBaSr38) の方が早いことがあります。Issue や pull request に、非公開ページの本文、認証情報、個人情報を貼らないでください。脆弱性は [SECURITY.md](SECURITY.md) です。

`help wanted` は外部の助けを求めている印です。`good first issue` は小さくて着手しやすい課題です。どちらも PR を歓迎する印です。

## 準備

- Node.js 24 と pnpm 12（`package.json` の `engines` と `packageManager`）。
- Docker は、ピン留めした wllama ランタイムを変えるときか、作り直すときだけです。[docs/BUILDING.md](docs/BUILDING.md) を参照してください。

```bash
pnpm install
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

`pnpm format` はファイルを書き直します。`pnpm test:e2e` はローカルのページで確認し、モデルはダウンロードしません。CI でも走ります。`pnpm build` と `pnpm zip` には、検証済みの wllama ビルドが必要です。lint、typecheck、単体テスト、画面文言、多くのソース変更には不要です。

## パッケージ化されていない拡張機能の読み込み

画面や content script の作業では:

```bash
pnpm dev
```

そのあと:

1. `chrome://extensions` を開きます。
2. **デベロッパー モード** をオンにします。
3. **パッケージ化されていない拡張機能を読み込む** を選びます。
4. このリポジトリの `.output/chrome-mv3` を選択します。

Chrome が変更を拾わないときは、拡張機能を再読み込みしてください。`pnpm dev` は wllama をコンパイルしません。展開したビルドで実際の PLaMo 翻訳をするには、ランタイムが一度必要です。

```bash
pnpm build:wllama   # Docker が必要です。docs/BUILDING.md を参照
pnpm verify:wllama
pnpm build          # 成果物は .output/chrome-mv3
pnpm build:firefox  # Firefox 153 以降。成果物は .output/firefox-mv3
```

`pnpm test:e2e` は、ページ内で翻訳するテスト用パッケージをビルドします。これはリリース用のビルドではありません。Firefox は `about:debugging` から `.output/firefox-mv3/manifest.json` を読みます。[docs/FIREFOX.md](docs/FIREFOX.md) を参照してください。

## 実際にあるコマンド

| コマンド             | 内容                                                  |
| -------------------- | ----------------------------------------------------- |
| `pnpm lint`          | ESLint                                                |
| `pnpm format`        | Prettier で書き込み                                   |
| `pnpm format:check`  | Prettier の確認（CI）                                 |
| `pnpm typecheck`     | `wxt prepare` と `svelte-check`                       |
| `pnpm test`          | Vitest                                                |
| `pnpm test:e2e`      | Playwright のフィクスチャ。モデルはダウンロードしない |
| `pnpm i18n:check`    | ロケールカタログを英語と突き合わせる                  |
| `pnpm build`         | 検証済み wllama のあとの Chrome 向け本番ビルド        |
| `pnpm build:firefox` | Firefox MV3。成果物は `.output/firefox-mv3`           |

通常の貢献に `pnpm bench`、`pnpm release`、Chrome ウェブストアへのアップロードは不要です。

## ブランチとコミット

pull request の先は `main` です。短い説明的なブランチ名で構いません（`fix/overlay-contrast`、`docs/shortcuts`）。

このリポジトリのコミット件名は、命令形の英文がほとんどです。Issue に紐づくときは末尾の `(#123)` がよく使われます。`docs:` や `chore:` の接頭辞があるコミットもありますが、必須ではありません。件名にも本文にも個人情報を書かないでください。

pull request の本文は [`.github/pull_request_template.md`](.github/pull_request_template.md) に従います。日本語でも英語でも構いません。Issue には `Closes #123` または `Refs #123` を付けます。使わない節は削って構いません。

## 画面の翻訳

画面の文言は `public/_locales/<lang>/messages.json` にあります。言語の追加はコピーだけの変更です。[docs/TRANSLATING.ja.md](docs/TRANSLATING.ja.md) を参照してください。テストは、欠けているキー、プレースホルダ、ブランド名、ライセンスの事実を英語と突き合わせます。一部だけのカタログは、読者に生の `__MSG_<key>__` を出さないよう失敗します。この作業用の Issue フォームがあります。

## コミットしないもの

- モデルの重み、`.env`、秘密情報。
- 生成した wllama の wasm（`vendor/wllama/`、`public/vendor/wllama/`）。
- `public/licenses/*.txt`。ビルドの前に `scripts/sync-licenses.mjs` が `LICENSE`、`NOTICE`、`licenses/` をそこにコピーします。

`licenses/` の PLaMo Community License は原文の写しです。書き直さないでください。モデルはそのライセンスのまま、実行時にダウンロードされます。

## リリース

メンテナがきれいな `main` で `pnpm release patch`（または `minor` / `major`）を実行します。コマンドはバージョンを上げ、`CHANGELOG.md` を更新し、コミットし、注釈付きタグを作ります。push はしません。貢献者はバージョンを上げたり、git タグを付けたり、リリース用ワークフローを実行したりしないでください。手順は [docs/RELEASING.md](docs/RELEASING.md) です。
