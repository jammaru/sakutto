# 画面の翻訳

Sakutto は UI の文言を Chrome 拡張のロケールとして `public/_locales/<言語>/messages.json` に置いています。言語を足すのは文言の追加だけで、TypeScript の変更もビルド設定の変更も要りません。

English: [TRANSLATING.md](TRANSLATING.md)

## すでに入っている言語

| カタログ | 言語                     | 出どころ |
| -------- | ------------------------ | -------- |
| `en`     | 英語                     | 原本     |
| `ja`     | 日本語                   | 原本     |
| `ko`     | 韓国語                   | PLaMo    |
| `zh_CN`  | 中国語（簡体字）         | PLaMo    |
| `zh_TW`  | 中国語（繁体字）         | PLaMo    |
| `es`     | スペイン語               | PLaMo    |
| `pt_BR`  | ポルトガル語（ブラジル） | 手書き   |
| `fr`     | フランス語               | PLaMo    |
| `de`     | ドイツ語                 | PLaMo    |
| `it`     | イタリア語               | PLaMo    |
| `ru`     | ロシア語                 | PLaMo    |
| `vi`     | ベトナム語               | PLaMo    |
| `th`     | タイ語                   | PLaMo    |
| `id`     | インドネシア語           | PLaMo    |

`pt_BR` だけ手書きです。PLaMo 3 Translate は `SUPPORTED_LANGUAGES` の 53 言語しか訳さず、`pt` は `CHROME_ONLY_LANGUAGES` に入っているためです。

## 言語を足す手順

1. 英語のカタログを複製します。

   ```sh
   cp -r public/_locales/en public/_locales/<言語>
   ```

   ディレクトリ名は Chrome の `_locales` の書き方に合わせます。小文字の言語コードと、必要なときだけ大文字の地域コードです（`pt_BR`、`zh_CN`、`zh_TW`）。

2. 複製した `messages.json` の `message` の値だけを訳します。ほかの項目はそのまま残します。

3. `src/shared/locales.ts` の `UI_LOCALES` にディレクトリ名を足します。ここがディレクトリと一致するまでテストは落ちるので、Chrome が選ばないカタログが混ざることはありません。

4. 確認します。

   ```sh
   pnpm test
   pnpm lint
   pnpm typecheck
   ```

## テストが守っていること

どれも好みの話ではなく、実際に壊れたか、壊れかけたものです。

**キーを落とさない。** キーが足りないと、`__MSG_<キー>__` がそのまま画面に出ます。`tests/locales.test.ts` が全カタログを英語と突き合わせます。

**`$TOKEN$` を落とさない。** 文言は `$NAME$` を含むことがあります。`placeholders` が各トークンと引数の位置を対応づけており、文言側の名前と宣言側のキーは大文字小文字を除いて一致する必要があります。

> 宣言していないトークンを文言が使っていると、Chrome は拡張機能そのものをインストールしません（`Failed to load extension … Variable $LANGUAGES$ used but not defined`）。実際に一度起きていて、当時のテストはどれも気づきませんでした。画面は Chrome ではなく JSON から描いていたためです。

`placeholders` があるキーは、英語の `placeholders` をそのまま複製してください。自分で足したり削ったりしないでください。

**ブランド名と製品名を変えない。** `extensionName` はどのカタログでも `Sakutto` で始まり、75 文字以内に収まります。ストアのタイトルに上限があるためです。`extensionShortName` はどのカタログでも `Sakutto` です。`PLaMo`、`PFN`、`Preferred Networks`、`Chrome`、`WebGPU`、`MIT`、`NOTICE`、`CSV` はそのまま書きます。

**事実を変えない。** ライセンスに同意する前に読者が知る必要のある事実が 3 つあります。

- `onboardingCommercialRevenue` の売上の上限
- `plamoRegistrationLink` の PFN の登録フォーム
- `onboardingModelNote` の標準モデルのサイズ（`src/engine/model/catalog.ts` が原典）

訳すのは構いませんが、数値を丸めたり、やわらげたり、言い換えたりしないでください。

## 文体

画面は「何が起きるか」を書き、立派さを語りません。そこに合わせます。

- 結果を書く（例:「モデルの準備ができるまで、ページは原文のまま表示します」）。
- 感嘆符を使わない。宣伝的な形容詞を使わない。速度を約束しない。
- 英語の二人称に合わせます。日本語は です・ます です。
- Chrome の内蔵翻訳が実際のエンジンになるのは、PLaMo が訳せない言語の組み合わせだけで、Chrome のときだけです。Firefox ではその言語と文言を出しません（`shortcutHelpFirefox`、`engineFirefoxSingleThread`、`tierCpu1`）。モデルの読み込み中に使えるもの、遅い PC の代わりになるもの、という書き方はしません。

この最後の点は、英語と日本語についてテストが見ています。言語を足すときは `onboardingUseNow` と `onboardingBridgeNote` をよく読んでください。

## PLaMo で下書きを作る

今入っている PLaMo 由来のカタログは、英語の文言を、拡張機能が同梱しているのと同じモデルに GPU 上で通して作り、そのあと目を通したものです。13 言語で用語がそろい、`$TOKEN$` とブランド名が残るのはこのためです。汎用のモデルではそうなりません。

同じことをする前に、2 点知っておいてください。

- **PLaMo は自分の 53 言語しか訳しません。** `SUPPORTED_LANGUAGES` の外の言語を渡すと、近い言語へ黙って訳します。`pt` を渡したらポーランド語になりました。コミットする前に出力を確かめてください。
- **信用せず、確認する。** 機械の出力でも、文体と「対訳表示」のような用語は母語の読者が見る必要があります。完成品ではなく下書きとして扱ってください。

## 変えてはいけないもの

`licenses/` には PLaMo Community License の原文が入っています。訳したり整形したりしないでください。同意の対象はその本文で、初回画面がリンクしているのは同梱の英語版と日本語版です。
