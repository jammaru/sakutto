## このPRについて

**#154（端末内 OCR）と PDF 翻訳品質改善を1本に統合**した PR 向けの本文ドラフトです。ベースは `main` です。#154 はオーナーがクローズ予定です。

---

## 端末内 OCR（PP-OCRv6）— #154 相当

PP-OCRv6 と ONNX Runtime Web により、スキャン PDF・画像の文字認識から翻訳までを端末内で実行します。PLaMo と同じ同意・ピン留め URL・SHA-256 検証・再開可能ダウンロード基盤を共有します。

- 初回設定で PLaMo と OCR モデルを一括ダウンロード
- 設定で標準／高精度 OCR を切り替え
- テキスト層のない PDF ページのみ遅延 OCR（段組・読み順・組版）
- 画像の右クリックメニューから OCR→翻訳パネル
- 14 ロケール、プライバシー・CWS 資料を更新

| 区分         | モデル                  | ダウンロードサイズ |
| ------------ | ----------------------- | -----------------: |
| 標準（既定） | tiny_det + small_rec    |         約 22.9 MB |
| 高精度       | medium_det + medium_rec |        約 138.6 MB |

---

## PDF 翻訳品質

テキスト層 PDF とスキャン PDF の未翻訳・言語混在・文字化け・重なりをオフラインで計測し改善しました。設計・実験の詳細は `bench/results/pdf-quality/PR_BODY.md` を参照してください。

### 品質指標（`pnpm bench:pdf:quality --label final`、fake engine）

| 指標       | baseline |     final |
| ---------- | -------: | --------: |
| 未翻訳散文 |    13.8% |  **0.0%** |
| 言語混在   |    20.9% |  **0.0%** |
| 文字化け   |    0.84% | **0.04%** |
| 読み順     |    98.3% | **98.3%** |

**scan 行は疑似 OCR**（レイアウト計測）。**実 OCR** は別表（`pnpm bench:pdf:scan:ocr`）。

### 実スキャン scan.pdf p1（real OCR、既定 default-1600）

|       CER |   WER | cross-column | ms/page |
| --------: | ----: | -----------: | ------: |
| **0.030** | 0.055 |            0 |  ~37.6s |

スクリーンショット: `bench/results/screenshots/baseline/` → `final/`（arXiv p1/p3/p5、scan 疑似・実 OCR `scan-p1-real-ocr.png`）

---

## 確認

- CI: lint / format / typecheck / test / e2e
- `pnpm bench:ocr` / `pnpm bench:pdf:quality` / `pnpm bench:pdf:scan:ocr`（コミット済み結果あり）
