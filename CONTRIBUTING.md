# Contributing

日本語: [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)

Sakutto is MIT-licensed. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

The usual path is an [Issue](https://github.com/jammaru/sakutto/issues) first, then a pull request for that Issue. That sequence is fully welcome. If you can, a PR is very much wanted. An Issue by itself is also totally welcome — you do not have to write code. Small PRs are enough: a typo, one locale, a docs fix, or a narrow bug fix.

Questions are often faster in [Discord](https://discord.gg/pdSRBaSr38). Do not paste private page content, credentials, or personal data into issues or pull requests. Security issues: [SECURITY.md](SECURITY.md).

`help wanted` means outside help is wanted. `good first issue` is a small, well-scoped task. Either label is an invitation to open a PR.

## Setup

- Node.js 24 and pnpm 12 (`package.json` has `engines` and `packageManager`).
- Docker, only when you change or rebuild the pinned wllama runtime. See [docs/BUILDING.md](docs/BUILDING.md).

```bash
pnpm install
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

`pnpm format` rewrites files. `pnpm test:e2e` runs local fixtures and does not download the model; CI runs it too. `pnpm build` and `pnpm zip` need a verified wllama build. You do not need that for lint, typecheck, unit tests, UI copy, or most source changes.

## Load the unpacked extension

For day-to-day work on the UI or content script:

```bash
pnpm dev
```

Then:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select `.output/chrome-mv3` in this repository.

Reload the extension after a rebuild if Chrome does not pick up the change. `pnpm dev` does not compile wllama. Real PLaMo translation in the unpacked build needs the runtime once:

```bash
pnpm build:wllama   # Docker; see docs/BUILDING.md
pnpm verify:wllama
pnpm build          # production build in .output/chrome-mv3
pnpm build:firefox  # Firefox 153+ in .output/firefox-mv3
```

`pnpm test:e2e` builds a separate package that translates inside the page. That package is not the release build. Firefox is loaded from `about:debugging` with `.output/firefox-mv3/manifest.json`; see [docs/FIREFOX.md](docs/FIREFOX.md).

## Commands that exist

| Command              | What it does                                               |
| -------------------- | ---------------------------------------------------------- |
| `pnpm lint`          | ESLint                                                     |
| `pnpm format`        | Prettier write                                             |
| `pnpm format:check`  | Prettier check (CI)                                        |
| `pnpm typecheck`     | `wxt prepare` and `svelte-check`                           |
| `pnpm test`          | Vitest                                                     |
| `pnpm test:e2e`      | Playwright fixtures; no model download                     |
| `pnpm i18n:check`    | Locale catalogs against English                            |
| `pnpm build`         | Production Chrome extension, after a verified wllama build |
| `pnpm build:firefox` | Firefox MV3 in `.output/firefox-mv3`                       |

You do not need `pnpm bench`, `pnpm release`, or a Chrome Web Store upload for a normal contribution.

## Branch and commits

Open a pull request against `main`. Short descriptive branch names are fine (`fix/overlay-contrast`, `docs/shortcuts`).

Commit subjects in this repository are usually an imperative English sentence. A trailing `(#123)` is common when the work belongs to an issue. `docs:` and `chore:` prefixes appear on some commits; they are optional. Do not put personal data in the subject or the body.

The pull request body follows [`.github/pull_request_template.md`](.github/pull_request_template.md). Japanese or English is fine. Point at the Issue with `Closes #123` or `Refs #123`. Delete sections that do not apply.

## Translating the interface

The UI strings live in `public/_locales/<lang>/messages.json`. Adding a language is a copy-only change: see [docs/TRANSLATING.md](docs/TRANSLATING.md). The suite checks every catalog against English for missing keys, placeholder tokens, brand names, and the licence facts, so a partial catalog fails rather than shipping raw `__MSG_<key>__` to a reader. There is an issue form for this work.

## What not to commit

- Model weights, `.env` files, and secrets.
- The generated wllama wasm (`vendor/wllama/`, `public/vendor/wllama/`).
- `public/licenses/*.txt`. `scripts/sync-licenses.mjs` copies `LICENSE`, `NOTICE`, and `licenses/` into that directory before a build.

The PLaMo Community License texts in `licenses/` are verbatim copies. Do not rewrite them. The model stays under that license and is downloaded at runtime.

## Releases

Maintainers ship from a clean `main` checkout with `pnpm release patch` (or `minor` / `major`). That command bumps the version, updates `CHANGELOG.md`, commits, and creates an annotated tag. It does not push. Contributors should not bump the version, add a git tag, or run the release workflow. See [docs/RELEASING.en.md](docs/RELEASING.en.md).
