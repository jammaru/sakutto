# 端末内OCR：スキャンPDF・画像翻訳 / On-device OCR for scanned PDFs and images

## 日本語

### 概要

PP-OCRv6 と ONNX Runtime Web を使い、スキャンPDFと画像の文字認識から翻訳までを端末内で行います。翻訳用の PLaMo と同じ同意・ピン留めURL・SHA-256検証・再開可能なダウンロード基盤を共有します。

- 初回設定で PLaMo と OCR モデルを一括ダウンロードし、結合した進捗を表示
- 設定で標準／高精度 OCR を切り替え、再開・キャンセル・画質ごとの削除に対応
- テキスト層のないPDFページだけを遅延 OCR し、段組・縦書き・読み順・組版を保持
- 画像の右クリックメニューから OCR→翻訳パネルを表示
- 英語・日本語など14の UI ロケール、プライバシー、CWS レビュー資料を更新

### OCR モデル

| 区分         | 検出／認識モデル        | ダウンロードサイズ |
| ------------ | ----------------------- | -----------------: |
| 標準（既定） | tiny_det + small_rec    |   22,939,968 bytes |
| 高精度       | medium_det + medium_rec |  138,587,816 bytes |

既定は生成 CC0 フィクスチャ8件の実測で選択しました。small_det+small_rec は設定の比較対象ではなく、ベンチマークの中間構成です。

### ベンチマーク

Node 24 / ONNX Runtime Web 1.31.1 WASM、生成 CC0 フィクスチャ8件、各モデル構成で測定しました。CER/WER は小さいほど良く、検出 recall proxy は IoU 0.30 の greedy one-to-one マッチです。時間はモデル初期化とウォームアップを除く1ページ平均です。

| 構成                  | Micro CER | Micro WER | 検出 recall proxy | 平均時間/ページ | Practical / Marginal |
| --------------------- | --------: | --------: | ----------------: | --------------: | -------------------: |
| tiny_det+small_rec    |      0.3% |      2.4% |              100% |          769 ms |                8 / 0 |
| small_det+small_rec   |      3.1% |      6.1% |              100% |        1,083 ms |                7 / 1 |
| medium_det+medium_rec |     10.3% |     20.6% |              100% |        5,836 ms |                6 / 2 |

標準構成は、英語スキャン、日本語横書き・縦書き、スライド、低解像度・傾き、2段組、日英混在、小文字の8件すべてで practical でした。生成フィクスチャの結果であり、実文書全体での優位性を保証するものではありません。OCR→翻訳の配線確認は英語と日本語の2ページについて、実 OCR 出力と決定的なローカル置換スタブで実施しています（翻訳品質の評価ではありません）。

再現: `pnpm bench:ocr`。詳細: `bench/results/ocr-benchmark.md`。

### 権限とプライバシー

- インストール時の `host_permissions` は引き続き空です。新規の画像配信元権限も追加しません。
- 画像は canvas / 匿名 CORS を優先し、失敗時だけ、右クリックによる既存の `activeTab` 許可で `captureVisibleTab` を使用します。
- ONNX Runtime WASM と OCR 辞書は同梱し、PP-OCRv6 の重みだけを Hugging Face から取得します。
- OCR のピクセルと認識文字を開発者や翻訳サーバーへ送りません。既存の任意ローカルサーバーを選んだ場合の扱いは従来どおりです。

### 検証

- `pnpm lint`
- `pnpm test` — 193 files, 2,404 passed, 1 optional smoke skipped
- `pnpm typecheck`
- `pnpm format:check`
- `pnpm exec wxt build`

---

## English

### Summary

This change adds on-device PP-OCRv6 recognition and translation for scanned PDFs and images using ONNX Runtime Web. OCR model management shares PLaMo's consent, immutable URLs, SHA-256 verification, resumable transfers, progress, cancellation, storage, and deletion infrastructure.

- Downloads PLaMo and OCR together during onboarding with combined progress
- Adds standard/high OCR tiers, resume/cancel, and per-tier deletion in Settings
- Runs lazy OCR only on PDF pages without a usable text layer, preserving columns, vertical Japanese, reading order, and fitted layout
- Adds an image context-menu action with an OCR source and translation panel
- Updates all 14 UI locales, privacy documentation, review notes, and third-party notices

### Benchmark and default

The default was selected by running real official ONNX weights over eight generated CC0 fixtures. CER/WER are lower-is-better; the detection proxy is greedy one-to-one AABB matching at IoU 0.30. Mean page time excludes initialization and warm-up.

| Pairing               | Micro CER | Micro WER | Detection recall proxy | Mean ms/page | Practical / Marginal |
| --------------------- | --------: | --------: | ---------------------: | -----------: | -------------------: |
| tiny_det+small_rec    |      0.3% |      2.4% |                   100% |          769 |                8 / 0 |
| small_det+small_rec   |      3.1% |      6.1% |                   100% |        1,083 |                7 / 1 |
| medium_det+medium_rec |     10.3% |     20.6% |                   100% |        5,836 |                6 / 2 |

The standard pairing was practical on every default-tier case: English scan, Japanese horizontal and vertical text, slides, low-resolution/skew, two columns, mixed Japanese/English, and small text. These generated-fixture results do not establish broad real-world superiority. English and Japanese OCR output also passed through a deterministic local translation stub as a plumbing sanity check, not as translation-quality evidence.

Reproduce with `pnpm bench:ocr`; see `bench/results/ocr-benchmark.md`.

### Permissions and privacy

Release `host_permissions` remains empty, with no new image-origin access. Canvas/CORS is attempted first; only a failed read falls back to `captureVisibleTab` under the existing `activeTab` grant from the context-menu click. ORT WASM and the dictionary are packaged locally, while pinned PP-OCRv6 weights are downloaded from Hugging Face. OCR pixels and recognized text are not uploaded.

### Validation

- `pnpm lint`
- `pnpm test` — 193 files, 2,404 passed, 1 optional smoke skipped
- `pnpm typecheck`
- `pnpm format:check`
- `pnpm exec wxt build`
