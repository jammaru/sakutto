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

## What not to commit

- Model weights, `.env` files, and secrets.
- The generated wllama wasm (`vendor/wllama/`, `public/vendor/wllama/`).
- `public/licenses/*.txt`. `scripts/sync-licenses.mjs` copies `LICENSE`, `NOTICE`, and `licenses/` into that directory before a build.

The PLaMo Community License texts in `licenses/` are verbatim copies. Do not rewrite them. The model stays under that license and is downloaded at runtime.

## Release

Owners ship from a clean `main` checkout with `pnpm release patch` (or `minor` / `major`). The command bumps the version, updates `CHANGELOG.md`, commits, and creates an annotated tag. It does not push. See [docs/RELEASING.md](docs/RELEASING.md) and [docs/RELEASING.en.md](docs/RELEASING.en.md).
