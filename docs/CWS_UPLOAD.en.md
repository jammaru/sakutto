# Upload to the Chrome Web Store

日本語: [CWS_UPLOAD.md](CWS_UPLOAD.md)

This updates the existing Chrome Web Store item through the official [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api) and [chrome-webstore-upload-cli](https://github.com/fregante/chrome-webstore-upload-cli/) 4.0.2. It does not use gcloud.

The item already exists on the developer dashboard for publisher jammaru. The first package is in review. This flow does not create the item, and it does not make the GitHub repository public.

The workflow runs only when the owner starts it with `workflow_dispatch`. A push to `main` does not run it. Pushing a `v*` tag does not run it either.

## Before you start

Turn on 2-step verification for the Google account. Fill in the store listing and privacy tabs before you publish or update.

The API does not skip review. `publish` submits the uploaded package for review. The store publishes it after review, using the visibility already saved on the item. Upload alone does not submit it.

## OAuth client and refresh token

Follow [Use the Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api).

Keep the credentials in GitHub Actions secrets only. Do not commit them, print them, or put them in `.env`.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Enable the Chrome Web Store API.
3. Configure the OAuth consent screen as External. Enter the app name, the user support email, and the developer contact. Add the Google account that owns the item as a test user.
4. Create a web application OAuth client. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI. Store the client ID as `CLIENT_ID` and the client secret as `CLIENT_SECRET`.
5. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground). In the settings, choose "Use your own OAuth credentials" and enter that client. Request the scope `https://www.googleapis.com/auth/chromewebstore`, authorize as the account that owns the item, and exchange the code for a refresh token. Store it as `REFRESH_TOKEN`.
6. Copy the publisher ID from the [developer dashboard](https://chrome.google.com/webstore/devconsole) publisher settings. Switch to the publisher that owns the item first when the account has more than one. The default is the `PUBLISHER_ID` below.
7. Copy the item ID from that dashboard. The default is the `EXTENSION_ID` below.

The account that mints the token must own the item. It can be a different account from the one that created the Cloud project.

## Values to store on GitHub

Add them under Settings, Secrets and variables, Actions.

These repository secrets are required. If one is missing, the workflow fails before it calls the API or builds the package. It does not print the values.

- `CLIENT_ID`
- `CLIENT_SECRET`
- `REFRESH_TOKEN`

`EXTENSION_ID` and `PUBLISHER_ID` are optional repository secrets or variables. A secret wins over a variable. When both are unset, the workflow uses:

- `EXTENSION_ID`: `mhlbjjijfkoghmcjndgdimhdlfkhadfl`
- `PUBLISHER_ID`: `a842b3f6-c065-46c2-b77a-0448bd11f52a`

The Release workflow's `CWS_*` secrets are a different set. This workflow does not read them.

## Bump the version

The `version` in the packaged `manifest.json` must be higher than the version already on the store, including a package that is still in review. The API rejects an upload that does not increase it.

WXT copies `version` from `package.json` into the manifest. Do not set `version` or `version_name` in `wxt.config.ts`.

From a clean `main` checkout:

```bash
pnpm release patch
```

`minor` and `major` work the same way. The command does not push. See [RELEASING.en.md](RELEASING.en.md). Run the workflow on the commit that contains the new version.

A pending submission can block the next upload. Wait for review, or cancel that submission in the dashboard, then upload a zip with a higher version.

## Run the workflow

Open Actions, Chrome Web Store, Run workflow. Choose the commit that contains the bumped version. That ref can be `main` or a `vX.Y.Z` tag.

Leave `publish` off to upload only. The package is not submitted for review. Turn `publish` on to upload and then call the publish API, which submits it for review. Re-running an upload-only run does not submit. Start a new run with `publish` on.

```bash
gh workflow run chrome-web-store.yml --ref vX.Y.Z
gh workflow run chrome-web-store.yml --ref vX.Y.Z -f publish=true
```

The zip comes from the same [package action](../.github/actions/package-extension/action.yml) CI uses. There is no second packaging path. Missing required secrets fail the run before that package job.

The publish API submits the item with the visibility saved in the dashboard. If you change that visibility and have not published once with the new setting, the API can reject publish.

## Local CLI

Use `chrome-webstore-upload-cli` 4.0.2. The 3.x CLI does not send the publisher ID required by API v2.

```bash
export CLIENT_ID="your-client-id"
export CLIENT_SECRET="your-client-secret"
export REFRESH_TOKEN="your-refresh-token"
export EXTENSION_ID="${EXTENSION_ID:-mhlbjjijfkoghmcjndgdimhdlfkhadfl}"
export PUBLISHER_ID="${PUBLISHER_ID:-a842b3f6-c065-46c2-b77a-0448bd11f52a}"

npx --yes chrome-webstore-upload-cli@4.0.2 upload --source <zip>
```

`<zip>` is the file `pnpm zip` writes under `.output/`. Its name is `sakutto-<version>-chrome.zip`. For example:

```bash
chrome-webstore-upload upload --source .output/sakutto-0.1.0-chrome.zip
```

Run this only when you want to submit that upload for review. Do not pass `--source` to `publish`.

```bash
chrome-webstore-upload publish
```

`chrome-webstore-upload` with no command uploads and publishes. For an upload only, pass `upload`.

Actions calls the same CLI through `node scripts/cws-upload.ts`. That script publishes only when `CWS_SUBMIT` is exactly `true`.

```bash
node scripts/cws-upload.ts .output/sakutto-0.1.0-chrome.zip
CWS_SUBMIT=true node scripts/cws-upload.ts .output/sakutto-0.1.0-chrome.zip
```

Locally, a missing `CLIENT_ID`, `CLIENT_SECRET`, or `REFRESH_TOKEN` fails before any API call. The script does not print the values.

## See also

- Release steps and the `CWS_*` secrets: [RELEASING.en.md](RELEASING.en.md)
- Official API: https://developer.chrome.com/docs/webstore/using-api
- CLI: https://github.com/fregante/chrome-webstore-upload-cli/
