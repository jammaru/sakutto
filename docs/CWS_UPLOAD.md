# Chrome ウェブストアへアップロードする

English: [CWS_UPLOAD.en.md](CWS_UPLOAD.en.md)

この文書は、既にある Chrome ウェブストアのアイテムを更新する手順です。公式の [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api) を、[chrome-webstore-upload-cli](https://github.com/fregante/chrome-webstore-upload-cli/) 4.0.2 から呼びます。gcloud は使いません。

アイテムは Developer Dashboard にあります。パブリッシャーは jammaru です。最初のパッケージは審査待ちです。この手順は新しいアイテムを作りません。GitHub リポジトリも公開しません。

アップロードと審査への提出は、所有者が Actions でこのワークフローを `workflow_dispatch` として手動実行したときだけです。`main` への push では動きません。バージョンタグ `v*` を push しても、このワークフローは動きません。

## 事前条件

Google アカウントで 2 段階認証を有効にしてください。公開または更新の前に、Developer Dashboard のストア掲載とプライバシーの欄を埋めます。

API は審査を省略しません。`publish` は、アップロードしたパッケージを審査へ提出します。審査を通過したあと、ストアの公開範囲に従って公開されます。アップロードだけでは提出しません。

## OAuth クライアントとリフレッシュトークン

手順の出典は、公式ガイドの [Use the Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api) です。

資格情報は GitHub の Actions secrets にだけ置いてください。リポジトリ、`.env`、ログ、コミットには書かないでください。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作るか、既存のプロジェクトを選びます。
2. 「Chrome Web Store API」を有効にします。
3. OAuth 同意画面を External で作り、アプリ名、ユーザーサポートのメール、開発者の連絡先を入力します。テストユーザーに、アイテムを所有する Google アカウントを追加します。
4. 認証情報で OAuth クライアント ID を作ります。アプリケーションの種類はウェブアプリケーションです。承認済みのリダイレクト URI に `https://developers.google.com/oauthplayground` を追加します。表示されたクライアント ID とクライアントシークレットを、それぞれ `CLIENT_ID` と `CLIENT_SECRET` にします。
5. [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) を開きます。設定で「Use your own OAuth credentials」を選び、クライアント ID とクライアントシークレットを入力します。スコープに `https://www.googleapis.com/auth/chromewebstore` を指定し、Authorize APIs から、アイテムを所有するアカウントで承認します。Exchange authorization code for tokens でリフレッシュトークンを受け取り、`REFRESH_TOKEN` にします。
6. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) のパブリッシャー設定に表示される ID を確認します。複数のパブリッシャーに属しているときは、対象のパブリッシャーに切り替えてから確認してください。既定値は下の `PUBLISHER_ID` です。
7. 同じダッシュボードのアイテム ID を確認します。既定値は下の `EXTENSION_ID` です。

トークンを発行するアカウントは、アイテムを所有するアカウントにしてください。Cloud プロジェクトを作ったアカウントと異なっても構いません。

## GitHub に登録する値

リポジトリの Settings、Secrets and variables、Actions に登録します。

必須の Repository secrets です。一つでも無いとき、ワークフローは API を呼ばずに失敗します。値はログに出しません。

- `CLIENT_ID`
- `CLIENT_SECRET`
- `REFRESH_TOKEN`

`EXTENSION_ID` と `PUBLISHER_ID` は、Repository secrets または Variables に置くと、その値を使います。secret が variable より優先されます。どちらも空のときは、次を使います。

- `EXTENSION_ID`: `mhlbjjijfkoghmcjndgdimhdlfkhadfl`
- `PUBLISHER_ID`: `a842b3f6-c065-46c2-b77a-0448bd11f52a`

Release ワークフローの `CWS_CLIENT_ID` などの `CWS_*` とは別の名前です。そちらが無くても、このワークフローは動きます。

## バージョンを上げる

アップロードするパッケージの `manifest.json` の `version` は、ストアに既にある版より大きくしてください。同じ version では API がアップロードを拒否します。審査待ちの版より大きい version にします。

WXT は `package.json` の `version` を manifest に写します。`wxt.config.ts` に `version` や `version_name` は書かないでください。

`main` の作業ツリーがきれいなときは、次で上げられます。詳細は [RELEASING.md](RELEASING.md) です。

```bash
pnpm release patch
```

`pnpm release minor` と `pnpm release major` も使えます。このコマンドは push しません。ワークフローは、上げた version が入っているコミットを ref にして実行します。

審査待ちの提出があるあいだは、新しいパッケージを受け取れないことがあります。そのときは Developer Dashboard で審査の完了を待つか、提出を取り消してから、version を上げた zip を再度アップロードします。

## ワークフローを実行する

Actions の「Chrome Web Store」を開き、Run workflow を選びます。ref は、上げた version のコミットです。`main` でも、タグ `vX.Y.Z` でも構いません。

`publish` をオフにすると、アップロードだけです。審査には提出しません。オンにすると、アップロードのあと publish API を呼び、審査へ提出します。オフの実行を再実行しても、提出にはなりません。提出するには、`publish` をオンにして新しい実行を開始します。

```bash
gh workflow run chrome-web-store.yml --ref vX.Y.Z
gh workflow run chrome-web-store.yml --ref vX.Y.Z -f publish=true
```

パッケージは、CI と同じ [package アクション](../.github/actions/package-extension/action.yml) で作ります。別の zip の作り方は使いません。必須の secret が無いときは、このパッケージ作業の前に失敗します。

公開 API は、ダッシュボードに保存されている公開範囲のまま審査へ提出します。公開範囲を変えたあとに、その範囲で一度も手動公開していない場合は、API の publish が拒否されることがあります。

## ローカル

CLI は `chrome-webstore-upload-cli` 4.0.2 です。3 系は API v2 のパブリッシャー ID を送りません。

```bash
export CLIENT_ID="your-client-id"
export CLIENT_SECRET="your-client-secret"
export REFRESH_TOKEN="your-refresh-token"
export EXTENSION_ID="${EXTENSION_ID:-mhlbjjijfkoghmcjndgdimhdlfkhadfl}"
export PUBLISHER_ID="${PUBLISHER_ID:-a842b3f6-c065-46c2-b77a-0448bd11f52a}"

npx --yes chrome-webstore-upload-cli@4.0.2 upload --source <zip>
```

`<zip>` は、`pnpm zip` が `.output/` に書くファイルです。名前は `sakutto-<version>-chrome.zip` です。例:

```bash
chrome-webstore-upload upload --source .output/sakutto-0.1.0-chrome.zip
```

審査へ提出するときだけ、アップロードのあとに実行します。`publish` に `--source` は付けません。

```bash
chrome-webstore-upload publish
```

引数のない `chrome-webstore-upload` は、アップロードと公開の両方を行います。アップロードだけにするときは、必ず `upload` を付けてください。

Actions は同じ CLI を `node scripts/cws-upload.ts` から呼びます。公開は、環境変数 `CWS_SUBMIT` が `true` のときだけです。

```bash
node scripts/cws-upload.ts .output/sakutto-0.1.0-chrome.zip
CWS_SUBMIT=true node scripts/cws-upload.ts .output/sakutto-0.1.0-chrome.zip
```

ローカルでも、上の 3 つの環境変数が無いときは API を呼ばずに失敗します。値は出力しません。

## 関連

- リリースと `CWS_*` の secrets: [RELEASING.md](RELEASING.md)
- 公式 API: https://developer.chrome.com/docs/webstore/using-api
- CLI: https://github.com/fregante/chrome-webstore-upload-cli/
