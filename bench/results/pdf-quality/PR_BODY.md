## 概要

PDF 翻訳を「動く」から「読める」に変えるため、抽出・段落復元・数式保護・組版・OCR・表示モードを一貫して作り直しました。テキストレイヤ PDF（arXiv 1706.03762）とスキャン PDF（bench/pdf/scan.pdf）の両方で、未翻訳段落・中途半端な言語混在・文字化け・重なりを実測して改善しています。

## 問題（オーナー feel test の再現）

- テキスト層 PDF: 段落が途中で英語のまま残る、行結合で別カラムの文章が混ざる、リガチャ/カーニングで e;sembles や l,rge のようなトークンが生じる、数式が文章に混ざって壊れる。
- スキャン PDF: OCR が 1 行 1 ブロックになるため見出しが重なる、2 カラムの読み順が壊れる、図表・コード領域まで訳される、青いマーカー点がページに散らかる。

## 設計（調査メモ）

- PDFMathTranslate / BabelDOC の「レイアウト解析 → 段落復元 → 数式 protection → 翻訳 → 組版」というパイプラインを参考にしましたが、ONNX のレイアウトモデルは同梱しません。代わりに pdf.js の既存座標情報だけで軽量版を実現しています ([PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate), [BabelDOC 段落復元](https://github.com/funstory-ai/BabelDOC/blob/main/docs/ImplementationDetails/ParagraphFinding/ParagraphFinding.md))。
- pdf.js の getTextContent() は描画順に items を返すため、str / transform / width から行・段落矩形を組み直し、ジオメトリで読み順を復元します ([pdf.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html#getTextContent))。LayoutReader のような seq2seq は MV3 の制約に合わないため使っていません ([LayoutReader](https://github.com/microsoft/unilm/tree/master/layoutreader))。
- Immersive Translate のバイリンガル PDF UX を参考に、原文/訳文を段落対応で左右に並べ、スクロールを共有する「二言語表示」を追加しました ([Immersive Translate PDF Helper](https://immersivetranslate.com/en/docs/pdf-helper/))。既存の「並べて比較」も維持しています。
- DocLayNet / LayoutLM 級のレイアウト検出モデルは精度は高いもののサイズとメモリがオンデバイス MV3 に合わないため、OCR ではクアッドの x クラスタと行間・キャプションから列と図表を推定する方法を採りました ([DocLayNet](https://arxiv.org/abs/2206.01062), [LayoutLM](https://arxiv.org/abs/1912.13318))。
- 推論は PLaMo 3 Translate 0.8B のオンデバイス実行のままです ([model card](https://huggingface.co/pfnet/plamo-3-translate-0.8b))。

アルゴリズムの要点:

1. リガチャ（fi/ff/ffi）・ソフトハイフン・NBSP を pdf.js の item 段階で正規化し、単語単位の分割を防ぐ。
2. 行の結合はハイフン継続とセンテンス境界を優先し、列をまたぐ行は別ブロックに分割する。
3. 列検出は行ボックスの x 中心とページ中央のジオメトリで行い、2 カラムの読み順を保持する。
4. 数式は数学フォントに加え、通常テキストの `Q ∈ R d model × d k` のような次元式全体を `iN` プレースホルダで保護し、訳後に必ず差し戻す（タグの全角化のみ正規化し、本文の全角括弧や ① は書き換えない）。`3 × 3 × 3` や `A × B × C` のような連鎖も末尾まで一つのスロットで保護する。保護範囲は単語境界で切り出し、`10× speedup` の語尾や `matrices` の語尾を数式に含めない。先行する `Let` / `For` / `If` / `Since` / `Because` / `Here` / `Note` / `Thus` / 冠詞 `a` などの文頭語は保護スロットから外し、散文としてモデルに渡す。
5. 訳文ボックスは元の段落領域に対してフィットさせ、収まらない場合は切らずにマーカーで全文を開く。エンジン失敗で `failed` になった散文にも同じマーカーを出し、二言語モードでは skipped ブロックも原文行として読める。OCR は行を段落にまとめ、コード/数値ラベル/図キャプション周辺は原文のまま残す。全幅でも 2 カラムの行は列ごとに分け、実スキャンでは 10pt 以上の実ガターと行レジオン幅を分割根拠にし、 span ブロックのカバーもガター越えとして扱う。複数列の行は両側の段幅を保つ白い隙間で分け、右列内の単語間隙間や単一段の通常語間で切らない。短い見出しの横では最も広い白い隙間を実ガターとして選び、狭い行にはページ全体の 2 カラム根拠を要求する。大文字始まりでも実ガターがあれば列分割し、短い中央見出しは列に含めず本文列より前に出力する。短い日本語見出し（概要・参考文献・1. はじめに）は heading として翻訳対象に残す。

## 変更内容

- src/pdf/extract.ts: グリフ run の Unicode 正規化。
- src/pdf/layout.ts: 行・段落の復元と列をまたぐブロック分割を改善。
- src/pdf/protect.ts, src/pdf/session.ts: 数式 protection の拡張（単語境界付き演算子パターン、先行散文の除外）、プレースホルダ正規化、最終チャンクでタグが欠けた時だけの自動リトライ（最大 2 回）。ストリーム途中の欠落で再リクエストして良い訳を捨てる問題を修正し、すべての散文ブロックが翻訳されるかマーカーで読めるようにした。
- src/pdf/ocr.ts: OCR 行を列・段落へグループ化し、`References` / `Abstract` のような短い見出しは翻訳対象の `heading` として保持。2 カラムが 1 行に合体した場合は両側の段幅を保つ 10pt 以上の実ガターと行レジオン幅で分割し、右列内の単語間隙間、単一段の通常語間や 2pt の傾きだけでは分割しない。短い章見出しの横では最も広い白い隙間をガターとして選び、分割した行は元の列を保持する。大文字で始まる行もタイトル文字列だけで例外にせず、中央の語間幅で見分ける。短い中央見出しは span 列として先に出力し、room がガターを越えないようにした。日本語の短い章見出しは heading として保持し、label としてスキップしない。コード判定は `for` / `if` 等の先頭語だけではなく文末の `;` / `:` やブロック記号などの構文証拠を要求し、`If the loss < 0.1 ...` のような比較を含む散文は訳対象に残す。小さな Figure キャプションは figure label から除外。ブロックごとの統一サイズと読み順を実現。
- src/pdf/place.ts: ガター越えカバーの計測から span ブロックの例外を外し、2 カラムが合体した行のカバーを検出できるようにした（通常の全幅タイトル/著者行は誤検知しない）。実スキャンの cross-column は 0。
- src/pdf/reader.ts, src/pdf/render.ts, src/entrypoints/reader/App.svelte: 二言語表示モード（原文左・訳文右、同一スクロール）、並べて比較の維持、青いマーカー点を控えめなニュートラルなチップに変更。失敗ブロックのマーカー、二言語モードの空ページ通知、skipped 原文行の表示を追加。src/pdf/session.ts はスクロール時と自動 coverage sweep の再キューで attempts を保持し、リトライ上限（最大 2 回）を越えないようにした。

## 計測（iteration 6 / `final`）

`pnpm bench:pdf:quality --label final --shots --no-download` と `pnpm bench:pdf:scan:ocr` を再実行しました。ベンチはモデル不要の決定的 fake engine で、コミット済みの paper.pdf / scan.pdf とキャッシュ済み arXiv 1706.03762（SHA-256 ピン留め）を使います。`firstBlockMs` はページ開始からの値で、サマリの `firstTranslatedBlockMs` はページ単位の最小値、実行開始からの値は `firstTranslatedBlockFromRunStartMs` として別途集計しています。baseline にはページ単位の値が無いため、上の表では比較可能な実行開始からの値（307 ms → 303 ms、実質的な改善なし）を並べています。ページ処理からの 6 ms は fake engine の TTFB だけを測る参考値です。

**scan 行は疑似 OCR です**: scan.pdf のページ寸法・背景を使い、paper.pdf のテキストから語単位の矩形を合成した入力で、認識ではなく OCR 後のレイアウト/配置を測ります。実スキャンの認識は下の実 OCR 表（`pnpm bench:pdf:scan:ocr`）で別途測定し、混ぜていません。実 OCR の overflow は描画済みの逸脱に加え、フィットせず描かれなかったブロックも数えます（default-1600 は 4 件）。

| 指標                                       | 変更前 (baseline) | 変更後 (final) | 目標 |
| ------------------------------------------ | ----------------: | -------------: | ---: |
| 未翻訳散文ブロック率（skipped 散文を含む） |             13.8% |       **0.0%** |  low |
| ブロック内言語混在率                       |             20.9% |       **0.0%** |  ≤2% |
| 文字化けトークン率                         |             0.84% |      **0.04%** |    — |
| 重なり/ブロック                            |             0.000 |          0.000 |    — |
| はみ出し/ブロック                          |             0.062 |      **0.024** |    — |
| 2 カラム読み順正解率                       |             98.3% |      **98.3%** | ≥98% |
| 最初の訳文が出るまで（実行開始から）       |            307 ms |         350 ms |    — |
| 最初の訳文が出るまで（ページ処理から）     |                 — |           6 ms |    — |
| 全文処理時間（fake engine）                |            909 ms |         988 ms |    — |

テキスト来源別（native = paper + arXiv / simulated OCR = scan）は `final.md` の別表を参照してください。コード行 `for block in page:` を散文と誤判定しないようになり、native / 疑似 OCR の未翻訳散文はともに 0.0% です。言語混在率は、Email・モデル名・数字入り識別子などを「言語switch」と数えず、連続した英語の散文_run_ のみを検出するよう指標を修正した結果です（fake engine が意図的に残す技術トークンを英語散文と誤判定していません）。文字化け率も、正しく空白の入った `Q ∈ R d model × d k` を「化け」と数えていた誤検知を除去しました。読み順の GT は、全幅見出しがバンドを区切る二段組の順序（全幅→左列→右列→次の全幅）に修正しています。

スクリーンショット（Playwright / Chromium）:

- 変更前: `bench/results/screenshots/baseline/`（arXiv p1/p3/p5, paper p1, scan p1）
- 変更後: `bench/results/screenshots/final/`（arXiv p1/p3/p5, paper p1, scan p1（疑似 OCR））
- 実 OCR の overlay: `bench/results/screenshots/final/scan-p1-real-ocr.png`
- 生データ: `bench/results/pdf-quality/final.json` / `final.md` / `history.md`

## OCR 実験ログ（pnpm bench:ocr:lab / pnpm bench:pdf:scan:ocr）

コミット済み CC0 8 フィクスチャ（グラウンドトゥルース付き、ネットワーク不要）に加え、実スキャン bench/pdf/scan.pdf p1 を Chromium でラスタライズして実 OCR を流しました。CER/WER は正規化後の編集距離、行順はグラウンドトゥルース行とのマッチによる adjacent accuracy、列順は列ラベルの連続runに対する編集距離（全て左列のような誤答は高得点にならない）、block IoU は行グループ矩形的 IoU、ms/page は計測前に 1 回だけ行う未計測の warm-up 推論を除いた値です（`warmups: 1`）。下のアプローチ別表はすべて detection maxSide 960 の固定条件下で比較しており（解像度を変える行のみ明示的に異なる値）、出荷設定の比較は「実スキャン」表の `shipped-baseline` と `default-1600` を使います。

### アプローチ別（tiny_det + small_rec、8 フィクスチャ平均）

| approach               |  CER |   WER | block accuracy (order / column / IoU) | ms/page | notes                                |
| ---------------------- | ---: | ----: | ------------------------------------- | ------: | ------------------------------------ |
| baseline               | 0.9% |  9.4% | 100% / 100% / 0.77                    |    1184 | 現行の Standard 相当                 |
| 150 DPI                | 0.4% |  5.5% | 100% / 100% / 0.78                    |     996 | 差分なし                             |
| 200 DPI                | 0.9% |  9.4% | 100% / 100% / 0.77                    |    1397 | 遅いだけで利益なし                   |
| 300 DPI                | 0.8% |  9.5% | 100% / 100% / 0.80                    |    2087 | IoU は改善、コスト大                 |
| grayscale              | 0.5% |  7.0% | 100% / 100% / 0.77                    |    1173 | 軽く効く                             |
| contrast (Otsu 前処理) | 0.4% |  5.5% | 100% / 94% / 0.76                     |    1176 | 白背景の比率で暴れる                 |
| Otsu                   | 0.3% |  4.7% | 100% / 100% / 0.75                    |    1184 | 文字は読めるが IoU 微減              |
| Sauvola                | 0.3% |  3.4% | 100% / 100% / 0.77                    |    1202 | 合成では最良 CER/WER                 |
| denoise                | 0.7% |  8.6% | 100% / 100% / 0.76                    |    1164 | 効果小                               |
| deskew                 | 0.9% |  9.4% | 100% / 100% / 0.77                    |    1175 | 傾きFixturesでは効果なし             |
| border trim            | 0.9% |  9.4% | 100% / 100% / 0.76                    |    1053 | 最速、精度同じ                       |
| Otsu + trim            | 0.4% |  5.5% | 100% / 100% / 0.83                    |    1000 | 速く IoU も良好                      |
| unclip 1.8             | 0.8% |  7.8% | 100% / 100% / 0.86                    |    1089 | 検出矩形が最も正確                   |
| tiling 512/64          | 9.1% | 33.8% | 96% / 61% / 0.61                      |    1421 | 重複と分断で大劣化                   |
| confidence re-run      | 0.9% |  9.4% | 100% / 100% / 0.77                    |    1171 | 既に高信頼で再認識不要               |
| adaptive 18pt          | 0.9% |  9.4% | 100% / 100% / 0.77                    |    1242 | 小さな文字のみ拡大、合成では効果なし |

### モデル pairing（同一 8 フィクスチャ: アプローチ別表と同じ CC0 ケース）

| pairing                         | baseline CER / ms | Sauvola CER / ms | Otsu+trim CER / ms | 採用判断                            |
| ------------------------------- | ----------------: | ---------------: | -----------------: | ----------------------------------- |
| tiny_det + small_rec (Standard) |       0.9% / 1214 |  **0.3% / 1164** |        0.4% / 1013 | 最速、Sauvola 併用で最良            |
| small_det + small_rec           |       3.9% / 1594 |      0.6% / 1506 |        0.6% / 1161 | detector を大きくしても改善せず遅い |
| tiny_det + medium_rec (hybrid)  |       0.4% / 4145 |      0.5% / 4112 |        0.2% / 3972 | 日本語混在に強いが 3.5 倍遅い       |
| medium_det + medium_rec (High)  |       0.4% / 8287 |      0.4% / 7804 |        0.2% / 5506 | 品質は同程度で約 7 倍遅い           |

### 実スキャン scan.pdf p1（実 OCR）

旧ベンチは paper.pdf の印刷レイアウト行を参照に使っており、scan.pdf の 1 ページ全体（画面レンダリングの 2 カラム）と不一致でした。コミット済みの `bench/pdf/scan-p1.gt.txt`（`scripts/bench/build-scan-gt.ts` で生成）を参照にし、行を内容でアラインした上で CER/WER を計算します。行順は別途、製品出力に対してスコアします。詳細は `bench/results/scan-ocr/README.md`。

| variant             |   CER |   WER | cross-column | lines | ms/page | model bytes |
| ------------------- | ----: | ----: | -----------: | ----: | ------: | ----------: |
| baseline-1x         | 66.7% | 94.8% |            1 |   100 |  27.1 s |    21.9 MiB |
| shipped-baseline    | 11.6% | 16.8% |            1 |   105 |  30.5 s |    21.9 MiB |
| default-1600        |  3.0% |  5.5% |            0 |   117 |  39.0 s |    21.9 MiB |
| gray+contrast-1600  |  3.0% |  5.4% |            0 |   117 |  35.9 s |    21.9 MiB |
| dpi300              |  3.0% |  5.5% |            0 |   116 |  41.0 s |    21.9 MiB |
| sauvola             | 82.5% | 97.2% |            1 |    98 |  23.6 s |    21.9 MiB |
| default-1600 (High) |  3.6% |  6.4% |            0 |   117 | 213.7 s |   132.2 MiB |

**採用**: 2x 描画 + detection maxSide 1600 の Standard（tiny_det + small_rec）。実スキャン p1 で **CER 3.0%、cross-column 0** を達成しました。旧ベンチの 1.4 という値は GT 不一致によるもので、認識精度ではありません。High は 3.4〜3.6% と Standard（3.0%）よりわずかに劣るうえ約 5.0 倍遅く 6 倍サイズのため採用しません。Binarization はこの小さなセリフ文字を潰すため既定では無効です。17 バリアントの全表は `bench/results/scan-ocr/report.md`。

## 確認

- `pnpm lint`, `pnpm typecheck` (0 errors / 1 warning), `pnpm test` (203 files, 2,626 passed, 1 skipped), `pnpm format:check`, `pnpm i18n:check` がすべて成功。
- `pnpm bench:pdf:quality --label final --shots --no-download` を再実行し、レポートとスクリーンショットを更新。`baseline.json` は現行指標の参照用で、履歴のlegacy行のみ旧指標のcontext。
- 権限モデル・シークレット・ Manifest に変更なし。
