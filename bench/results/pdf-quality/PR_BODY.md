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
4. 数式は数学フォントに加え、通常テキストの Q ∈ R d のような演算子 run も `iN` プレースホルダで保護し、訳後に必ず差し戻す（タグの全角化も正規化）。
5. 訳文ボックスは元の段落領域に対してフィットさせ、収まらない場合は切らずにマーカーで全文を開く。OCR は行を段落にまとめ、コード/数値ラベル/図キャプション周辺は原文のまま残す。

## 変更内容

- src/pdf/extract.ts: グリフ run の Unicode 正規化。
- src/pdf/lines.ts / src/pdf/layout.ts: 行・段落の復元と列をまたぐブロック分割を改善。
- src/pdf/protect.ts, src/pdf/session.ts: 数式 protection の拡張、プレースホルダ正規化、失敗時の自動リトライ（最大 2 回）。すべての散文ブロックが翻訳されるかマーカーで読めるようにした。
- src/pdf/ocr.ts: OCR 行を列・段落へグループ化し、コード/図表ラベルを skipped へ分離。ブロックごとの統一サイズと読み順を実現。
- src/pdf/reader.ts, src/pdf/render.ts, src/entrypoints/reader/App.svelte: 二言語表示モード（原文左・訳文右、同一スクロール）、並べて比較の維持、青いマーカー点を控えめなニュートラルなチップに変更。

## 計測

pnpm bench:build:mock は既存の fake engine ビルドです。新しい pnpm bench:pdf:quality はモデル・ネットワーク不要で、コミット済みの paper.pdf / scan.pdf とキャッシュされた arXiv 1706.03762（初回のみダウンロード、bench/.cache 配下）に対して、fake engine の決定的な訳し出しで同一条件を再現します。

| 指標 | 変更前 | 変更後 |
| --- | ---: | ---: |
| 未翻訳散文ブロック率 | 13.0% | **0.0%** |
| ブロック内言語混在率 | 20.9% | **10.8%** |
| 文字化けトークン率 | 0.84% | **0.31%** |
| 重なり/ブロック | 0.000 | 0.000 |
| はみ出し/ブロック | 0.062 | **0.046** |
| 2 カラム読み順正解率 | 98.3% | 98.3% |
| 最初の訳文が出るまで | 307 ms | **261 ms** |
| 全文処理時間（fake engine） | 909 ms | **823 ms** |

ページ別の主な変化: arXiv p1 の未翻訳散文 3 → 0、p5 の 3 → 0、scan p1 の 8 → 0。scan のブロック数は 58 → 37 に減り、1 行ずつだったオーバーレイが段落単位になりました。

スクリーンショット（Playwright / Chromium）:

- 変更前: bench/results/screenshots/baseline/arxiv-p1.png, arxiv-p3.png, arxiv-p5.png, scan-p1.png
- 変更後: bench/results/screenshots/final/arxiv-p1.png, arxiv-p3.png, arxiv-p5.png, scan-p1.png
- 数値の生データ: bench/results/pdf-quality/baseline.json, final.json, history.md

## OCR 実験ログ（pnpm bench:ocr:lab / pnpm bench:pdf:scan:ocr）

コミット済み CC0 8 フィクスチャ（グラウンドトゥルース付き、ネットワーク不要）に加え、実スキャン bench/pdf/scan.pdf p1 を Chromium でラスタライズして実 OCR を流しました。CER/WER は正規化後の編集距離、行順/列順はグラウンドトゥルース行とのマッチによる adjacent accuracy、block IoU は行グループ矩形的 IoU、ms/page はモデル warm-up を除いた値です。

### アプローチ別（tiny_det + small_rec、8 フィクスチャ平均）

| approach | CER | WER | block accuracy (order / column / IoU) | ms/page | notes |
| --- | ---: | ---: | --- | ---: | --- |
| baseline | 0.9% | 9.4% | 100% / 97% / 0.77 | 1208 | 現行の Standard 相当 |
| 150 DPI | 0.9% | 9.4% | 100% / 97% / 0.77 | 1139 | 差分なし |
| 200 DPI | 0.9% | 9.4% | 100% / 97% / 0.77 | 1373 | 遅いだけで利益なし |
| 300 DPI | 0.8% | 9.5% | 100% / 97% / 0.80 | 1998 | IoU は改善、コスト大 |
| grayscale | 0.5% | 7.0% | 100% / 97% / 0.77 | 1121 | 軽く効く |
| contrast (Otsu 前処理) | 0.4% | 5.5% | 100% / 95% / 0.76 | 1133 | 白背景の比率で暴れる |
| Otsu | 0.3% | 4.7% | 100% / 97% / 0.75 | 1121 | 文字は読めるが IoU 微減 |
| Sauvola | 0.3% | 3.4% | 100% / 97% / 0.77 | 1118 | 合成では最良 CER/WER |
| denoise | 0.7% | 8.6% | 100% / 97% / 0.76 | 1110 | 効果小 |
| deskew | 0.9% | 9.4% | 100% / 97% / 0.77 | 1102 | 傾きFixturesでは効果なし |
| border trim | 0.9% | 9.4% | 100% / 97% / 0.76 | 968 | 最速、精度同じ |
| Otsu + trim | 0.4% | 5.5% | 100% / 97% / 0.83 | 949 | 速く IoU も良好 |
| unclip 1.8 | 0.8% | 7.8% | 100% / 97% / 0.86 | 1019 | 検出矩形が最も正確 |
| tiling 512/64 | 9.1% | 33.8% | 100% / 95% / 0.61 | 1352 | 重複と分断で大劣化 |
| confidence re-run | 0.9% | 9.4% | 100% / 97% / 0.77 | 1115 | 既に高信頼で再認識不要 |
| adaptive 18pt | 0.9% | 9.4% | 100% / 97% / 0.77 | 1138 | 小さな文字のみ拡大、合成では効果なし |

### モデル pairing（同一 4 ケース: en-scan / small-text / mixed-ja-en / two-column）

| pairing | baseline CER / ms | Sauvola CER / ms | Otsu+trim CER / ms | 採用判断 |
| --- | ---: | ---: | ---: | --- |
| tiny_det + small_rec (Standard) | 1.7% / 1269 | **0.2% / 1239** | 0.9% / 1068 | 最速、Sauvola 併用で最良 |
| small_det + small_rec | 1.7% / 1795 | 0.9% / 1780 | 0.6% / 1202 | detector を大きくしても改善せず遅い |
| tiny_det + medium_rec (hybrid) | 0.9% / 4547 | 0.6% / 4536 | 0.4% / 4327 | 日本語混在に強いが 3.5 倍遅い |
| medium_det + medium_rec (High) | 0.9% / 8328 | 0.4% / 8212 | 0.4% / 5347 | 品質は同程度で 6 倍遅い |

### 実スキャン scan.pdf p1（実 OCR）

| variant | CER* | WER* | cross-column | overlaps | ms | 読みやすさ |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1x (旧 detection maxSide 960) | 0.912 | 1.783 | 0 | 0 | 22696 | 本文が文字化け、74 → 35 ブロックに集約 |
| 2x raster + maxSide 1280 | 1.389 | 1.725 | 2 | 0 | 29560 | 列またぎは 10 → 2 に減少 |
| 2x raster + maxSide 1920 | 1.412 | 1.628 | **0** | 0 | 35736 | 本文が正しく読める、列またぎなし |
| 1x + Sauvola | **0.725** | **0.963** | 3 | 0 | 20933 | 文字が潰れ、行が欠落 |
| 2x + Sauvola | 0.792 | 1.368 | 2 | 0 | 27955 | 本文が潰れる |
| 2x + grayscale | 1.400 | 1.742 | 2 | 0 | 29571 | 列またぎが残る |

\* 実スキャンの参照は paper.pdf の各行で、OCR の行分割が異なるため CER/WER は相対比較のみ。肉眼で読める本文は maxSide 1920（2x raster を落とさない）が明確に最良でした。

**採用したデフォルト**: Standard（tiny_det + small_rec）を維持し、PDF の OCR ラスタは既存の 2x 描画を detection で落とさないよう maxSide を 960 → 1600 に変更しました。二値化は合成 Fixtures では効きましたが実スキャンで文字を潰すため既定では有効にせず、High は設定で選べるままにしています。OCR 後の行→段落グルーピング、列単位の room、コード/数値行・キャプション周辺のスキップ、ハイフン接続とリガチャ正規化を追加し、scan.pdf p1 の列またぎ・重なり・コード翻訳を解消しました。

## 確認

- pnpm lint, pnpm typecheck, pnpm test, pnpm test:e2e を実行。
- i18n は 14 ロケールすべてでキー整合を確認（新規 pdfBilingual を追加）。
- 既存の権限モデル・シークレットに変更なし。
