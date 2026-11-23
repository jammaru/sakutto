# 端末内OCR：スキャンPDF・画像翻訳 / On-device OCR for scanned PDFs and images

## 日本語

### 概要

PP-OCRv6 と ONNX Runtime Web を使い、スキャンPDFと画像の文字認識から翻訳までを端末内で行います。翻訳用の PLaMo と同じ同意・ピン留めURL・SHA-256検証・再開可能なダウンロード基盤を共有します。

- 初回設定で PLaMo と OCR モデルを一括ダウンロードし、結合した進捗を表示
- 設定で標準／高精度 OCR を切り替え、再開・キャンセル・画質ごとの削除に対応
- テキスト層のないPDFページと、ネイティブ文字で覆われていないラスタ部分を遅延 OCR し、段組・縦書き・読み順・組版を保持
- 画像の右クリックメニューから OCR→翻訳パネルを表示
- 英語・日本語など14の UI ロケール、プライバシー、CWS レビュー資料を更新
- 今回のレビューの 6 件のブロッカーを修正：日本語・短い英文の見出し誤判定と段落分割、短い左段本文のページ横断見出し誤判定、単語単位の非対称ガター分割、スキャン正解テキストの段組読み順、trim 前処理の座標逆変換、ベンチ推奨の出荷構成ラベル
- 最新の DSH レビューの 6 件のブロッカーも修正：右列内の語間で切れる OCR ガター分割、実スキャン overflow の過小報告、コード行の散文誤判定、coverage sweep によるリトライ上限のバイパス、連鎖数式の末尾保護漏れ、レポートと生データの不一致
- 今回の DSH レビューの 4 件のブロッカーも修正：ページ中央に近い語間をガターと誤る分割、非対称段組の短い左段行の右段誤登録と cross-column 指標の取りこぼし、空の翻訳をリトライ回数に数えない経路、キーワード＋コロン節の散文を見落とす判定
- 最新の DSH レビューの 4 件のブロッカーも修正：単一段の通常語間や短い中央見出しの誤分割、大文字始まりの合体行をタイトルと誤判定して列分割しない問題、短い日本語見出しの label 誤判定と未翻訳、ベンチ PR のレポート数値と生データの不一致

### OCR モデル

| 区分         | 検出／認識モデル        | ダウンロードサイズ |
| ------------ | ----------------------- | -----------------: |
| 標準（既定） | tiny_det + small_rec    |   22,939,968 bytes |
| 高精度       | medium_det + medium_rec |  138,587,816 bytes |

既定はレイテンシ優先です。生成 CC0 フィクスチャ8件の実測では、高精度構成の認識前処理をアスペ比保持に修正した後、標準 0.7% / 1,413 ms、高精度 0.4% / 10,847 ms でした。small_det+small_rec は設定の比較対象ではなく、ベンチマークの中間構成です。

### ベンチマーク

Node 24 / ONNX Runtime Web 1.31.1 WASM、生成 CC0 フィクスチャ8件、各モデル構成で測定しました。CER/WER は小さいほど良く、検出 recall proxy は IoU 0.30 の greedy one-to-one マッチです。時間はモデル初期化とウォームアップを除く1ページ平均です。

| 構成                  | Micro CER | Micro WER | 検出 recall proxy | 平均時間/ページ | Practical / Marginal |
| --------------------- | --------: | --------: | ----------------: | --------------: | -------------------: |
| tiny_det+small_rec    |      0.7% |      7.3% |              100% |        1,413 ms |                8 / 0 |
| small_det+small_rec   |      3.5% |     10.9% |              100% |        2,115 ms |                7 / 1 |
| medium_det+medium_rec |      0.4% |      4.2% |              100% |       10,847 ms |                8 / 0 |

標準構成は、英語スキャン、日本語横書き・縦書き、スライド、低解像度・傾き、2段組、日英混在、小文字の8件すべてで practical でした。生成フィクスチャの結果であり、実文書全体での優位性を保証するものではありません。OCR→翻訳の配線確認は英語と日本語の2ページについて、実 OCR 出力と決定的なローカル置換スタブで実施しています（翻訳品質の評価ではありません）。

再現: `pnpm bench:ocr`。詳細: `bench/results/ocr-benchmark.md`。

実スキャン `bench/pdf/scan.pdf` p1 は、コミット済みの正解テキスト（`bench/pdf/scan-p1.gt.txt`）に対して `pnpm bench:pdf:scan:ocr` で測定します。旧ベンチの参照は印刷用 paper.pdf の行でスキャンレイアウトと不一致でした。修正後の出荷設定（2x / maxSide 1600, Standard）は CER 3.0% / WER 5.5%、cross-column 0、約 35 秒/ページです。実スキャンの overflow は未描画のフィット失敗も数え、default-1600 で 6 件です。詳細: `bench/results/scan-ocr/README.md`。組版品質ベンチは mixed language 0.0%（目標 ≤2%）、reading order 98.3%（目標 ≥98%）を維持しています。

### 権限とプライバシー

- インストール時の `host_permissions` は引き続き空です。新規の画像配信元権限も追加しません。
- 画像は canvas / 匿名 CORS を優先し、失敗時だけ、右クリックによる既存の `activeTab` 許可で `captureVisibleTab` を使用します。
- ONNX Runtime WASM と OCR 辞書は同梱し、PP-OCRv6 の重みだけを Hugging Face から取得します。
- OCR のピクセルと認識文字を開発者や翻訳サーバーへ送りません。既存の任意ローカルサーバーを選んだ場合の扱いは従来どおりです。

### 検証

- `pnpm lint`
- `pnpm test` — 202 files, 2,607 passed, 1 optional smoke skipped
- `pnpm typecheck`
- `pnpm format:check`
- `pnpm exec wxt build`

---

## English

### Summary

This change adds on-device PP-OCRv6 recognition and translation for scanned PDFs and images using ONNX Runtime Web. OCR model management shares PLaMo's consent, immutable URLs, SHA-256 verification, resumable transfers, progress, cancellation, storage, and deletion infrastructure.

- Downloads PLaMo and OCR together during onboarding with combined progress
- Adds standard/high OCR tiers, resume/cancel, and per-tier deletion in Settings
- Runs lazy OCR on image-only PDF pages and on pages whose raster content is not covered by a usable text layer, preserving columns, vertical Japanese, reading order, and fitted layout
- Adds an image context-menu action with an OCR source and translation panel
- Updates all 14 UI locales, privacy documentation, review notes, and third-party notices
- Fixes six review blockers: Japanese and short English body lines misread as headings, short left-column lines treated as spanning headings, word-level asymmetric-gutter splits, scan ground-truth column order, trim-preprocess coordinate mapping, and mislabeled shipped-default recommendations
- Also fixes six blockers from the latest DSH review: an OCR gutter split landing inside the right column, under-reported real-scan overflow, a code listing counted as prose, a coverage sweep bypassing the retry cap, an unprotected tail of a chained formula, and report artifacts contradicting the committed data
- Fixes four blockers from this DSH review: a word gap near the page midpoint chosen as the gutter, a short left-column line misgrouped into the right column (and the integrity metric that hid its cover), an empty translation that bypassed the retry cap, and keyword-plus-colon prose mislabeled as code
- Fixes four blockers from the latest DSH review: splitting a single-column word gap or short centred title at the page midpoint, leaving a capitalised merged two-column row whole because it looked title-like, skipping short Japanese section headings as labels, and PR text contradicting the committed bench data

### Benchmark and default

The default is latency-first; the high tier uses the same weights with a larger detector/recognizer. After fixing the high tier's recognition preprocessing to preserve aspect ratio, the eight generated CC0 fixtures measured 0.7% micro-CER / 1,413 ms for standard versus 0.4% / 10,847 ms for high. CER/WER are lower-is-better; the detection proxy is greedy one-to-one AABB matching at IoU 0.30. Mean page time excludes initialization and warm-up.

| Pairing               | Micro CER | Micro WER | Detection recall proxy | Mean ms/page | Practical / Marginal |
| --------------------- | --------: | --------: | ---------------------: | -----------: | -------------------: |
| tiny_det+small_rec    |      0.7% |      7.3% |                   100% |        1,413 |                8 / 0 |
| small_det+small_rec   |      3.5% |     10.9% |                   100% |        2,115 |                7 / 1 |
| medium_det+medium_rec |      0.4% |      4.2% |                   100% |       10,847 |                8 / 0 |

The standard pairing was practical on every default-tier case: English scan, Japanese horizontal and vertical text, slides, low-resolution/skew, two columns, mixed Japanese/English, and small text. These generated-fixture results do not establish broad real-world superiority. English and Japanese OCR output also passed through a deterministic local translation stub as a plumbing sanity check, not as translation-quality evidence.

Reproduce with `pnpm bench:ocr`; see `bench/results/ocr-benchmark.md`. The real scan bench keeps the shipped Standard row at CER 3.0% and cross-column 0, with overflow counting unpainted fit failures (6 blocks); see `bench/results/scan-ocr/report.md`. The PDF quality bench keeps mixed-language at 0.0% (target ≤2%) and reading order at 98.3% (target ≥98%); see `bench/results/pdf-quality/final.md`.

### Permissions and privacy

Release `host_permissions` remains empty, with no new image-origin access. Canvas/CORS is attempted first; only a failed read falls back to `captureVisibleTab` under the existing `activeTab` grant from the context-menu click. ORT WASM and the dictionary are packaged locally, while pinned PP-OCRv6 weights are downloaded from Hugging Face. OCR pixels and recognized text are not uploaded.

### Validation

- `pnpm lint`
- `pnpm test` — 202 files, 2,607 passed, 1 optional smoke skipped
- `pnpm typecheck`
- `pnpm format:check`
- `pnpm exec wxt build`
