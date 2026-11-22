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
| 最初の訳文が出るまで | 307 ms | **248 ms** |
| 全文処理時間（fake engine） | 909 ms | **840 ms** |

ページ別の主な変化: arXiv p1 の未翻訳散文 3 → 0、p5 の 3 → 0、scan p1 の 8 → 0。scan のブロック数は 58 → 37 に減り、1 行ずつだったオーバーレイが段落単位になりました。

スクリーンショット（Playwright / Chromium）:

- 変更前: bench/results/screenshots/baseline/arxiv-p1.png, arxiv-p3.png, arxiv-p5.png, scan-p1.png
- 変更後: bench/results/screenshots/final/arxiv-p1.png, arxiv-p3.png, arxiv-p5.png, scan-p1.png
- 数値の生データ: bench/results/pdf-quality/baseline.json, final.json, history.md

## 確認

- pnpm lint, pnpm typecheck, pnpm test, pnpm test:e2e を実行。
- i18n は 14 ロケールすべてでキー整合を確認（新規 pdfBilingual を追加）。
- 既存の権限モデル・シークレットに変更なし。
