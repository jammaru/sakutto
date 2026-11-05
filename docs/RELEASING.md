# リリース手順

English: [RELEASING.en.md](RELEASING.en.md)

この文書は、Sakutto for PLaMo を Chrome ウェブストアへ出す手順です。

## ローカルでバージョンを上げる

`main` の作業ツリーがきれいなときだけ、次のいずれかが動きます。

```bash
pnpm release patch
pnpm release minor
pnpm release major
```

コマンドは次を行います。

1. ブランチが `main` でない、未コミットの変更（未追跡のファイルを含む）がある、または上げた版が `main` に取り込まれている最新の `vX.Y.Z` タグより新しくないとき、何も変えずに止まります。
2. `package.json` の `version` を上げます。WXT は拡張機能の manifest version をこの値から作ります。`wxt.config.ts` に `version` や `version_name` は書かないでください。書いた状態ではコマンドが止まります。
3. 直前の `vX.Y.Z` タグ以降のコミット件名で、`CHANGELOG.md` に節を追加します。タグがまだ無いときは、履歴全体が対象です。マージコミットは入れません。日付は UTC です。
4. `chore: release vX.Y.Z` というコミットを作ります。
5. 注釈付きタグ `vX.Y.Z` を作ります。タグを作れなかったときは、そのリリースのコミットも取り消します。
6. push はしません。最後の行に、実行すべきコマンドを出します。

```bash
git push origin main vX.Y.Z
```

表示されたコマンドで、`main` とそのタグを push してください。タグの push が Release ワークフローを開始します。push する前に `git show` でコミットとタグを確認できます。

リモートの `main` が進んでいると push は拒否されます。そのときは `main` を更新し、リリースのコミットを載せ直してから、同じ形のコマンドを実行してください。

## タグを push したあと

[`.github/workflows/release.yml`](../.github/workflows/release.yml) が `v*` のタグで動きます。通常の pull request ではこのワークフローは動きません。

1. タグ名が `package.json` の version に `v` を付けたものと一致することを確認します。`CHANGELOG.md` にその版の節があることも確認します。
2. 既存の CI と同じく、lint、format、typecheck、unit test、e2e を実行します。
3. 既存の package アクション（[`.github/actions/package-extension`](../.github/actions/package-extension/action.yml)）で、wllama の復元またはビルド、`pnpm zip`、パッケージ検査（`scripts/verify-package.ts`）、worker のスモークテストを行います。
4. ビルドした `manifest.json` の version が `package.json` と一致することを確認します。
5. GitHub Release を下書きで作り、ストア用 zip を添付し、`CHANGELOG.md` のその節を本文にします。下書きは自動では公開しません。
6. Chrome ウェブストア用のシークレットが揃っているときだけ、パッケージをアップロードします。タグの push では公開しません。

## Chrome ウェブストアへ公開する

アップロードと公開は別です。タグの push はアップロードだけです。審査へ提出して公開するには、同じタグでワークフローを手動実行し、`publish` を true にします。Actions の再実行は、元のタグ push の再実行なので、公開にはなりません。

```bash
gh workflow run release.yml --ref vX.Y.Z -f publish=true
```

この実行はパッケージを再度アップロードし、そのあと公開 API を呼びます。公開 API は審査に提出し、通過後に公開します。GitHub Release は下書きのままです。ストアの公開と、GitHub Release の公開は別です。

手動実行の ref はバージョンタグにしてください。`main` ではバージョン確認で失敗します。

## Chrome ウェブストア API の資格情報

公式の Chrome Web Store API（v2）を使います。この API は既存のアイテムを更新します。最初のストア掲載は、Developer Dashboard で作ってください。

資格情報は GitHub の Actions secrets にだけ置いてください。リポジトリ、`.env`、ログ、コミットには書かないでください。

次がすべて設定されているときだけアップロードします。一つでもないときは、値を出さずにスキップした旨をログへ出し、GitHub の下書きリリースは続行します。

- `CWS_EXTENSION_ID`
- `CWS_CLIENT_ID`
- `CWS_CLIENT_SECRET`
- `CWS_REFRESH_TOKEN`
- `CWS_PUBLISHER_ID`

`CWS_PUBLISHER_ID` は、現行の公式 API が URL に要求するパブリッシャー ID です。

Google アカウントでは 2 段階認証が必要です。公開または更新の前に、Developer Dashboard のストア掲載とプライバシーの欄を埋めてください。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作るか、既存のプロジェクトを選びます。
2. 「Chrome Web Store API」を有効にします。
3. OAuth 同意画面を External で作り、アプリ名、ユーザーサポートのメール、開発者の連絡先を入力します。テストユーザーに、アイテムを所有する Google アカウントを追加します。
4. 認証情報で OAuth クライアント ID を作ります。アプリケーションの種類はウェブアプリケーションです。承認済みのリダイレクト URI に `https://developers.google.com/oauthplayground` を追加します。表示されたクライアント ID とクライアントシークレットを、それぞれ `CWS_CLIENT_ID` と `CWS_CLIENT_SECRET` にします。
5. [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) を開きます。設定で「Use your own OAuth credentials」を選び、クライアント ID とクライアントシークレットを入力します。スコープに `https://www.googleapis.com/auth/chromewebstore` を指定し、Authorize APIs から、アイテムを所有するアカウントで承認します。Exchange authorization code for tokens でリフレッシュトークンを受け取り、`CWS_REFRESH_TOKEN` にします。
6. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) のパブリッシャー設定に表示される ID を `CWS_PUBLISHER_ID` にします。複数のパブリッシャーに属しているときは、対象のパブリッシャーに切り替えてから確認してください。
7. 同じダッシュボードのアイテム ID を `CWS_EXTENSION_ID` にします。
8. リポジトリの Settings、Secrets and variables、Actions に、上の 5 つを Repository secrets として登録します。

トークンを発行するアカウントは、Chrome ウェブストアのアイテムを所有するアカウントにしてください。Cloud プロジェクトを作ったアカウントと異なっても構いません。

## 更新とモデル

Chrome ウェブストアの更新では、拡張機能 ID は変わりません。モデルの重みは、その ID のオリジンに紐づく OPFS（Origin Private File System）に保存します。実装は `OpfsModelFileStore` で、`navigator.storage.getDirectory()` の `sakutto` ディレクトリです。

拡張機能のプログラムだけが変わる更新では、保存済みのモデルを再ダウンロードしません。完成しているかの判定は、保存した `model.json` の SHA-256 およびサイズと、実ファイルのサイズが、カタログ `src/engine/model/catalog.ts` の値と一致するかどうかです。カタログの SHA-256 またはサイズが変わったときは、保存済みのファイルを完成品として扱わないため、モデルを再度ダウンロードします。利用者がモデルを削除したときも、次に使うときにダウンロードします。

ストア版と、別の拡張機能 ID で読み込んだパッケージ（たとえばパッケージ化されていない拡張機能）はオリジンが違うため、モデルを共有しません。

## 関連

- ビルド: [BUILDING.md](BUILDING.md)
