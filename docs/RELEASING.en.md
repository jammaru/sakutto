# Releasing

日本語: [RELEASING.md](RELEASING.md)

From a clean `main` checkout:

```bash
pnpm release patch
pnpm release minor
pnpm release major
```

The command refuses a dirty tree, including untracked files, and any branch other than `main`. It also refuses a version that is not newer than the highest `vX.Y.Z` tag merged into `main`. It bumps the `version` in `package.json`. WXT copies that value into the extension manifest, so do not set `version` or `version_name` in `wxt.config.ts`. It prepends a `CHANGELOG.md` section made from commit subjects since the previous `vX.Y.Z` tag, or from the whole history when no release tag exists. It commits `chore: release vX.Y.Z` and creates an annotated tag. If the tag cannot be created, that commit is removed. It does not push. The last line of output is the command to run:

```bash
git push origin main vX.Y.Z
```

Pushing that tag runs `.github/workflows/release.yml`. Pull requests do not run it. The workflow checks the tag against `package.json` and `CHANGELOG.md`, runs the same lint, format, typecheck, unit, and e2e checks as CI, then runs the existing package action. That action restores or builds wllama, runs `pnpm zip` (including the package audit), and smoke-tests the worker. The workflow then checks the built manifest version and opens a draft GitHub Release with the store zip attached and the changelog section as the notes.

Chrome Web Store upload uses the official API v2. It runs only when every repository secret below is set. Otherwise it logs a skip line and the draft release still proceeds. A tag push uploads only. It does not publish. Publishing submits the item for review:

```bash
gh workflow run release.yml --ref vX.Y.Z -f publish=true
```

Run that on the version tag. Re-running the original tag push does not publish. The GitHub Release stays a draft either way. The API updates an existing store item; create the first listing in the dashboard.

Set these as GitHub Actions repository secrets only. Do not commit them, print them, or put them in `.env`.

- `CWS_EXTENSION_ID` — item id from the developer dashboard
- `CWS_CLIENT_ID` and `CWS_CLIENT_SECRET` — OAuth web client
- `CWS_REFRESH_TOKEN` — refresh token from the OAuth playground
- `CWS_PUBLISHER_ID` — publisher id required in the v2 API URL

The Google account needs 2-step verification. Fill in the store listing and privacy tabs before publishing.

1. In Google Cloud Console, enable the Chrome Web Store API.
2. Configure the OAuth consent screen as External, and add the item owner as a test user.
3. Create a web application OAuth client. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI.
4. In the OAuth playground, use that client, request the scope `https://www.googleapis.com/auth/chromewebstore`, authorize as the account that owns the item, and exchange the code for a refresh token.
5. Copy the publisher id from the dashboard publisher settings, and the extension id from the item.
6. Store the five values as repository Actions secrets.

The model stored in OPFS is not downloaded again on an extension update unless the model changes. A store update keeps the extension id, so the origin and its OPFS directory (`sakutto`, from `navigator.storage.getDirectory()`) remain. The saved file stays ready while its SHA-256 and size match `src/engine/model/catalog.ts`. A new catalog hash or size, or a delete by the user, downloads the model again. An unpacked extension with a different id does not share that storage.
