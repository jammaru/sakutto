# Contributing

Sakutto is MIT-licensed. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Setup

- Node.js 24 and pnpm 12.
- Docker, only when you change or rebuild the pinned wllama runtime. See [docs/BUILDING.md](docs/BUILDING.md).

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

`pnpm test:e2e` does not download the model. `pnpm build` and `pnpm zip` need a verified wllama build.

## Translating the interface

The UI strings live in `public/_locales/<lang>/messages.json`. Adding a language is a copy-only
change: see [docs/TRANSLATING.md](docs/TRANSLATING.md). The suite checks every catalog against
English for missing keys, placeholder tokens, brand names, and the licence facts, so a partial
catalog fails rather than shipping raw `__MSG_<key>__` to a reader.

## What not to commit

- Model weights, `.env` files, and secrets.
- The generated wllama wasm (`vendor/wllama/`, `public/vendor/wllama/`).
- `public/licenses/*.txt`. `scripts/sync-licenses.mjs` copies `LICENSE`, `NOTICE`, and `licenses/` into that directory before a build.

The PLaMo Community License texts in `licenses/` are verbatim copies. Do not rewrite them. The model stays under that license and is downloaded at runtime.

## Release

Owners ship from a clean `main` checkout with `pnpm release patch` (or `minor` / `major`). The command bumps the version, updates `CHANGELOG.md`, commits, and creates an annotated tag. It does not push. See [docs/RELEASING.md](docs/RELEASING.md) and [docs/RELEASING.en.md](docs/RELEASING.en.md).

Uploading that package with `chrome-webstore-upload-cli` is a separate manual workflow. It does not run on pushes to `main`. See [docs/CWS_UPLOAD.md](docs/CWS_UPLOAD.md).
