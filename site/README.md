# Sakutto official site

Self-contained Astro site for <https://sakutto.jammaru.com>. The Japanese landing
lives at `/`, the English landing at `/en/`, and the privacy policies at
`/privacy/` and `/en/privacy/`. The build is fully static: no Worker
entrypoint and no server-side rendering.

## Requirements

Node.js 22.23+ (Node 24 recommended) and npm. The Cloudflare CLI (`cf`) and
the Cloudflare Vite plugin are pinned development dependencies; no global
install and no Wrangler configuration are needed. The plugin emits Cloudflare
Build Output from the static Astro build, which is what `cf build` and `cf
deploy --dry-run` validate.

## Commands

```sh
cd site
npm install
npm run dev        # astro dev on 127.0.0.1
npm run build      # refresh social stats, then astro build into dist/
npm run preview    # cf dev (local preview of the built project)
npm run check      # astro check
npm run optimize-media  # regenerate compressed/responsive public/ media
npm run deploy     # cf deploy (real deploy; do not run casually)
```

For a credential-free validation run, use offline stats and a dry run:

```sh
SAKUTTO_STATS_OFFLINE=1 npm run build
npx cf build
npx cf deploy --dry-run
```

`cf deploy --dry-run` builds and validates the assets-only Worker without
uploading anything and without Cloudflare credentials. `npm run preview` (`cf
dev`) is the local Cloudflare preview; it also needs no login.

## Image delivery

The JA and EN 1200x630 OG cards are committed as static JPEGs in `public/`
and copied into `dist/` by Astro. Update the files in place when the artwork
changes; the build does not regenerate them.

`scripts/optimize-media.mjs` regenerates the right-sized hero AVIF/WebP
variants (including an exact 1152w candidate for the 1x desktop wall), the
512w/720w story posters and the small feature illustration from the originals
in `media-source/` (kept outside the deployed `public/` tree). Only assets
referenced by the built pages are shipped in `public/`; capture provenance is
recorded in `docs/MEDIA_SOURCES.md`. The hero `<picture>` in `PageDemo.astro`
and the preload hint in `SakuttoLayout.astro` share the same `srcset`/`sizes`
definitions in `src/data/sakutto-media.ts`. Below-fold demos start from a
responsive poster and upgrade to the animated WebP only when they approach the
viewport. `public/_headers` gives build assets and static media an immutable
cache.

`scripts/build-deferred.mjs` bundles the post-paint interactions into
`public/sakutto-init.js`. The tiny inline loader adds it one second after the
`load` event, so no JavaScript request competes with the LCP image.

## Social stats and privacy policy

`scripts/fetch-sakutto-social-stats.mjs` refreshes
`src/data/sakutto-social-stats.json` at build time and falls back to the
checked-in values when the network is unavailable. Set
`SAKUTTO_STATS_OFFLINE=1` to skip all network requests. Never hand-edit the
numbers: they come from the store listing or the GitHub API, or from the
committed fallback.

The policy body is committed at `content/PRIVACY.md` and rendered at build
time, so there are no runtime or build-time API requests for it.

## Cloudflare configuration

`cloudflare.config.ts` declares the `sakutto-site` assets-only Worker, a
recent compatibility date, and the custom domain `sakutto.jammaru.com`. The
domain is documentation only: the build and CI steps never deploy, and nothing
in this directory changes Cloudflare account resources. A real deploy is
outside the scope of this README and must be performed deliberately with
`npm run deploy`.

`astro.config.mjs` pins the local tsconfig for Vite so a nested checkout does
not resolve a tsconfig from the repository above `site/`. Static assets are
served from the client build output; there is no Worker entrypoint and no SSR.
