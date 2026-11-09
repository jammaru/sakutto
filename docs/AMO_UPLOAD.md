# Signing and submitting the Firefox package

English follows the Japanese section.

この文書は、Firefox 版を AMO の listed チャネルへ出す手順です。署名も提出も、所有者が Actions で `AMO` ワークフローを `workflow_dispatch` として手動実行したときだけです。`main` への push では動きません。このエージェントや CI の pull request ジョブは署名しません。

## Secrets

リポジトリの Settings、Secrets and variables、Actions に次を登録します。値はログに出しません。

- `AMO_JWT_ISSUER` — addons.mozilla.org の API キー（JWT issuer）
- `AMO_JWT_SECRET` — 同じ画面の JWT secret

キーは https://addons.mozilla.org/developers/addon/api/key/ で発行します。2段階認証が必要です。

## gecko id

`browser_specific_settings.gecko.id` は `sakutto@jammaru` です（`src/shared/browser.ts`）。AMO に一度出すと変えられません。ワークフローを回す前に、この id でよいか確認してください。

## 手順

1. `pnpm zip:firefox` と `pnpm source:firefox` がローカルまたは CI の firefox ジョブで通ること。
2. `pnpm lint:firefox` がエラー 0 であること。
3. Actions で `AMO` を手動実行する。listed 提出が既定です。
4. ワークフローは `web-ext sign --channel listed --upload-source-code … --amo-metadata amo-metadata.json --approval-timeout 0` を呼びます。

掲載文は `docs/AMO_LISTING.md`、審査メモは `docs/AMO_REVIEW_NOTES.md`、ソースのビルド手順は `SOURCE_CODE_REVIEW.md` です。

## 提出後

`web-ext sign` はスクリーンショットも審査メモも送りません。ワークフローが終わったら、AMO の開発者ハブで次を行ってください。

1. スクリーンショットをアップロードする
2. `docs/AMO_REVIEW_NOTES.md` の英語ブロックを Notes for Reviewers に貼る

# Uploading to AMO

This is the listed-channel path for the Firefox package. Signing and submit happen only when the owner runs the `AMO` workflow with `workflow_dispatch`. A push to `main` does not sign. Pull request CI builds and lints; it does not call `web-ext sign`.

Add repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` from https://addons.mozilla.org/developers/addon/api/key/. Confirm gecko id `sakutto@jammaru` before the first listed upload.

## After submit

`web-ext sign` does not upload screenshots or reviewer notes. After the workflow finishes, in the AMO developer hub:

1. Upload screenshots
2. Paste the English block from `docs/AMO_REVIEW_NOTES.md` into Notes for Reviewers
