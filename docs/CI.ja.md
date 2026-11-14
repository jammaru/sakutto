# CI 運用手順

English: [CI.md](CI.md)

このリポジトリの GitHub Actions の手順です。拡張機能が配布する中身は変えません。タグのリリースは wllama をソースからコンパイルします。

## SLO

GitHub-hosted の `ubuntu-latest`、キャッシュが生きている前提です。ゲートではなく目標です。

| 指標                                                             | 目標                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| PR のフィードバック p50（キャッシュヒット、wllama 再ビルドなし） | 2 分以内                                                       |
| PR のフィードバック p95（キャッシュヒット）                      | 6 分以内                                                       |
| wllama キャッシュミス時の壁時計                                  | 20 分以内（コンパイルは 1 回）                                 |
| main の成功率和（キャンセル以外）                                | 99% 以上                                                       |
| フレーク                                                         | 既知 0。リトライはインフラの一時失敗だけ                       |
| `v*` Release                                                     | 必ず green。shallow clone とキャッシュだけに頼った wasm は不可 |

```sh
node scripts/ci-stats.ts jammaru/sakutto 200
```

この変更一式での実測（`ubuntu-latest`）は [CI.md](CI.md) にあります。数値は `checks` を分割する前のものです。ミスは壁時計 11m 55s（コンパイル 1 回 10m 18s）、ヒットは 2m 07s（`wllama` 9s）。

## ワークフロー

| ワークフロー                                      | きっかけ                                                         | 何のため                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ci.yml`                                          | PR（draft と `ready_for_review` を含む）、`main` への push、手動 | lint / 型 / 単体 / e2e / ピン留め検査 / 必要ならパッケージ             |
| `model-pins.yml`                                  | 同じ PR/`main`、毎日 03:17 UTC                                   | ピン留め GGUF URL の Range 確認                                        |
| `release.yml`                                     | `v*` タグ、手動                                                  | タグ検証、wllama をソースからビルド、Chrome zip、GitHub Release 下書き |
| `chrome-web-store.yml` / `amo.yml`                | 手動だけ                                                         | ストア提出。PR から dispatch しない                                    |
| `pr-labeler.yml` / `community.yml` / `labels.yml` | ラベルと歓迎コメント                                             | 安い。残す                                                             |

## CI ジョブ

`changes` のあと、次のジョブが並列で動きます。

- `checks-static`: `pnpm lint`、`pnpm format:check`、`pnpm typecheck`。常に実行。
- `checks-unit`: `pnpm test`、`pnpm bench:equality --check`。`fetch-depth: 0` で常に実行。
- `e2e`: Playwright の `--shard=i/3` で 3 並列。`fullyParallel: true` なのでファイル単位ではなくテスト単位で分かれます。PR が docs だけ（`code=false`）のときだけ skip。`main` への push と `workflow_dispatch` では skip しません。
- `checks`: 上記と `changes` を `needs` に持つ集約ジョブ。branch protection 用の名前を固定し、失敗・キャンセルがあれば赤、e2e の意図的な skip なら緑。

`main` への push と手動実行では e2e を必ず実行します。docs だけの PR でも static と unit は実行します。

## 必須チェック（推奨。リポジトリ設定はこの PR では変えない）

1. CI の `checks`（static / unit / equality / e2e の集約）
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
- Playwright は `playwright-chromium-${RUNNER_OS}-${ImageOS}-<pnpm-lock sha256>` を 3 つの e2e shard で共有し、キャッシュヒット時は `PLAYWRIGHT_SKIP_INSTALL=1` で install を省きます。apt のフォントは入れません（`--with-deps` なし）。

`main` では in-progress をキャンセルしません。PR ブランチだけキャンセルします。

## 遅い・赤いとき

- ジョブ要約（`$GITHUB_STEP_SUMMARY`）の `changes` と `wllama` を見る。
- `checks` が赤なら、失敗した `checks-static` / `checks-unit` / e2e shard を開く。テストのリトライはない。
- `bench-fixtures` がコミットを見つけられない → `fetch-depth: 0`。
- コンパイルが 2 本並列 → `wllama` ジョブが消えている。回帰。
- モデルピンの 429/5xx → 一時的。チェッカーは 2 回リトライする。403 やサイズ不一致は本物。

## ロールバック

ワークフローとアクションのコミットを `main` で戻します。配布物の中身はこの PR では変わっていません。
