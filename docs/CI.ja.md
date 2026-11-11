# CI 運用手順

English: [CI.md](CI.md)

このリポジトリの GitHub Actions の手順です。拡張機能が配布する中身は変えません。タグのリリースは wllama をソースからコンパイルします。

## SLO

GitHub-hosted の `ubuntu-latest`、キャッシュが生きている前提です。ゲートではなく目標です。

| 指標                                                             | 目標                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| PR のフィードバック p50（キャッシュヒット、wllama 再ビルドなし） | 5 分以内                                                       |
| PR のフィードバック p95（キャッシュヒット）                      | 10 分以内                                                      |
| wllama キャッシュミス時の壁時計                                  | 20 分以内（コンパイルは 1 回）                                 |
| main の成功率和（キャンセル以外）                                | 99% 以上                                                       |
| フレーク                                                         | 既知 0。リトライはインフラの一時失敗だけ                       |
| `v*` Release                                                     | 必ず green。shallow clone とキャッシュだけに頼った wasm は不可 |

```sh
node scripts/ci-stats.ts jammaru/sakutto 200
```

## ワークフロー

| ワークフロー                                      | きっかけ                                                         | 何のため                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ci.yml`                                          | PR（draft と `ready_for_review` を含む）、`main` への push、手動 | lint / 型 / 単体 / e2e / ピン留め検査 / 必要ならパッケージ             |
| `model-pins.yml`                                  | 同じ PR/`main`、毎日 03:17 UTC                                   | ピン留め GGUF URL の Range 確認                                        |
| `release.yml`                                     | `v*` タグ、手動                                                  | タグ検証、wllama をソースからビルド、Chrome zip、GitHub Release 下書き |
| `chrome-web-store.yml` / `amo.yml`                | 手動だけ                                                         | ストア提出。PR から dispatch しない                                    |
| `pr-labeler.yml` / `community.yml` / `labels.yml` | ラベルと歓迎コメント                                             | 安い。残す                                                             |

## 必須チェック（推奨。リポジトリ設定はこの PR では変えない）

1. CI の `checks`
2. CI の `pinned-wllama`
3. Model pins の `range`

`Package chrome` / `Package firefox` は必須にしない（通常の PR では skip されるため）。

PR に CI が無く、label と community だけが動いているときは、ほぼ **マージコンフリクト** です。GitHub はコンフリクト中の `pull_request` を実行しません。`pull_request_target` は動きます。draft だからスキップされているのではありません。`main` に rebase して push してください。

## キャッシュ

- wasm のキーは `wllama-v2-<入力の sha256>`（`scripts/wllama-cache-key.ts`）。`patches/optional/` はキーに入れません。
- 古い wasm を `restore-keys` で拾いません。
- 保存は `wllama` ジョブが `verify:wllama` のあと、パッケージの前に行います。
- ヒットしたキャッシュは再検証し、壊れていれば捨ててソースからビルドします。
- キーを捨てるときはプレフィックスを変えます。

`main` では in-progress をキャンセルしません。PR ブランチだけキャンセルします。

## 遅い・赤いとき

- ジョブ要約（`$GITHUB_STEP_SUMMARY`）の `changes` と `wllama` を見る。
- `bench-fixtures` がコミットを見つけられない → `fetch-depth: 0`。
- コンパイルが 2 本並列 → `wllama` ジョブが消えている。回帰。
- モデルピンの 429/5xx → 一時的。チェッカーは 2 回リトライする。403 やサイズ不一致は本物。

## ロールバック

ワークフローとアクションのコミットを `main` で戻します。配布物の中身はこの PR では変わっていません。
