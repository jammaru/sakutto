# CI runbook

日本語の手順は [CI.ja.md](CI.ja.md) です。

This is the maintainer runbook for GitHub Actions in this repository. It does not change
what the extension ships. Tag releases still compile wllama from source.

## SLOs

Targets are for GitHub-hosted `ubuntu-latest` and assume the Actions cache is healthy.
They are goals, not gates.

| Signal                                          | Target         | Why                                                                                      |
| ----------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| PR feedback p50 (warm cache, no wllama rebuild) | ≤ 5 min        | Lint, tests, and e2e should return while the change is still in working memory.          |
| PR feedback p95 (warm cache)                    | ≤ 10 min       | Queueing and Playwright install should not routinely blow past ten minutes.              |
| PR / main wall clock on a wllama cache miss     | ≤ 20 min       | One emscripten compile, not two. Cache saved even if a later package job fails.          |
| main green rate (non-cancelled)                 | ≥ 99%          | A red default branch stops every other PR.                                               |
| Flaky-test rate                                 | 0 known flakes | Failures should be deterministic. Retry only transient infra (image pull, HTTP 429/5xx). |
| Release `v*`                                    | Must be green  | Shallow-clone bugs and cache-only wasm are not acceptable on a tag.                      |

`scripts/ci-stats.ts` prints p50/p95 for recent workflow runs:

```sh
node scripts/ci-stats.ts jammaru/sakutto 200
```

Measured on this change set (GitHub-hosted `ubuntu-latest`). The miss is the first PR run after the `wllama-v2-` key; the hit is the next push with the same wasm inputs.

| Path                                                                    | CI run                                                                     | Wall clock | `wllama` | Package chrome | Package firefox | `checks` |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------: | -------: | -------------: | --------------: | -------: |
| miss (before: chrome 12m21s + firefox 17m09s in parallel, wall ~18 min) | [43009192000](https://github.com/jammaru/sakutto/actions/runs/43009192000) |    11m 55s |  10m 18s |            52s |          1m 21s |   1m 59s |
| hit                                                                     | pending                                                                    |            |          |                |                 |          |

## Workflows

| Workflow               | Trigger                                                                                         | Purpose                                                                                                          | Needed on           |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------- |
| `ci.yml`               | `pull_request` (including drafts and `ready_for_review`), `push` to `main`, `workflow_dispatch` | Lint, format, typecheck, unit tests, e2e, pinned-wllama check, Chrome/Firefox package when the zip inputs change | PRs and main        |
| `model-pins.yml`       | same PR/main events, plus daily `17 3 * * *`                                                    | HEAD range-check the pinned GGUF URLs                                                                            | PRs, main, schedule |
| `release.yml`          | `v*` tags, `workflow_dispatch`                                                                  | Recheck the tag, compile wllama from source, zip Chrome, draft GitHub Release, optional CWS upload               | Tags only           |
| `chrome-web-store.yml` | `workflow_dispatch` only                                                                        | Upload (and optionally publish) the Chrome zip                                                                   | Manual              |
| `amo.yml`              | `workflow_dispatch` only                                                                        | Sign and submit the Firefox zip to AMO listed                                                                    | Manual              |
| `pr-labeler.yml`       | `pull_request_target`                                                                           | Path labels from `.github/labeler.yml` on the base branch                                                        | PRs                 |
| `community.yml`        | new issues / PRs                                                                                | Welcome comment and `needs-triage` on first issues                                                               | Issues/PRs          |
| `labels.yml`           | changes to `.github/labels.yml`                                                                 | Sync issue labels; dry-run on PRs                                                                                | Rare                |

Do not dispatch `chrome-web-store.yml` or `amo.yml` from a pull request.

### CI jobs

| Job                                  | Typical duration             | When it runs                                                                                                                                      |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changes`                            | ~10 s                        | Always. Classifies the diff (`scripts/ci-changed.ts`). Docs-only diffs set `code=false`.                                                          |
| `checks`                             | ~2 min                       | Always. Full clone (`fetch-depth: 0`) so `tests/bench-fixtures.test.ts` can see history.                                                          |
| `pinned-wllama`                      | ~10–20 s                     | Always. `node scripts/wllama/build.ts --check`.                                                                                                   |
| `wllama`                             | ~1 min hit / ~12–15 min miss | Manual runs, PRs that touch zip/wllama inputs, and code pushes to `main`. One compile. Saves the cache before packaging.                          |
| `Package chrome` / `Package firefox` | ~1–2 min after wllama        | Same condition as `wllama`. Restore the artifact; do not compile again. Firefox keeps `web-ext lint`, the second zip, and the source-zip rebuild. |

`checks` stays serial on one runner. Splitting lint/typecheck/unit/e2e would add extra `pnpm install` cost for about 40 s of wall-clock on the warm path, which is already under the p50 SLO.

## Required checks (recommendation)

Do not change repository rules from this PR. Recommended required checks on `main`:

1. `checks` (CI) — lint, format, typecheck, unit, equality, e2e
2. `pinned-wllama` (CI)
3. `range` (Model pins)

`Package chrome` / `Package firefox` should **not** be required. They are skipped on ordinary PRs (no zip-input change), and a skipped required check is either pending or a false green depending on the ruleset. They still run on `main` for code changes and on PRs that touch the package path.

Draft PRs should receive the same `pull_request` checks. GitHub does **not** run `pull_request` workflows while the PR has merge conflicts; `pull_request_target` (labels, welcome) still runs. Rebase onto `main` and push. Switching CI to `pull_request_target` would run untrusted PR code against the base branch and is not used.

## Caching

### wllama wasm

- Key: `wllama-v2-<sha256 of build inputs>` from `scripts/wllama-cache-key.ts`.
- Inputs: every file under `scripts/wllama/` except `patches/optional/`, plus `src/engine/wllama/firefox-webgpu-kick.ts`. Optional patches are not applied and must not bust the cache.
- Restore is exact-key only. There is no `restore-keys` fallback: an older wasm would be the wrong bits.
- The cache is saved from the `wllama` job after `pnpm verify:wllama` succeeds, before Chrome/Firefox packaging. A later package failure does not lose the compile.
- A restored cache is verified again. A poisoned entry is deleted and rebuilt.
- Prefix `wllama-v2-` is the bust mechanism. Changing the prefix is enough; do not delete other people's caches by hand.

### emsdk image

- Key: `emsdk-<tag>-<runner.arch>` (currently `4.0.20` on `X64`).
- Used only on a wasm miss. `docker pull` retries three times (transient registry failures).

### pnpm and Playwright

- `actions/setup-node` `cache: pnpm` on install jobs.
- Playwright browsers: `playwright-chromium-${RUNNER_OS}-<pnpm-lock sha256>`.

### What not to cache

- Do not restore wasm with a prefix fallback.
- Do not cache `vendor/wllama/.checkout/build` into the wasm key. Incremental object files are a future experiment; they are large and can hide a bad compile.

## Concurrency

```yaml
cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

PR pushes cancel the previous run on that branch. `main` and tags do not cancel. The v1.3.0 release spent 12–17 min compiling because the #63 merge run was cancelled ~7 min in and never saved the cache.

## Release and the Chrome Web Store

- `release.yml` Checks uses `fetch-depth: 0` (same reason as CI `checks`).
- `release.yml` Package sets `from-source: true` on `.github/actions/package-extension`. It does not restore a CI wasm cache. `wllama-build.json` still records inputs and output hashes.
- The GitHub Release stays a draft. Tag push uploads to CWS only when the `CWS_*` secrets are set; it does not publish.
- `chrome-web-store.yml` and `amo.yml` stay manual. They use the same package action (cache restore is allowed there so a maintainer is not forced through a 15 min compile to re-upload). The tag workflow is the from-source path.
- Do not print secrets. Workflows pass them through `env:` and never `run: echo`.

## When CI is slow

1. Open the run and read `$GITHUB_STEP_SUMMARY` on `changes` and `wllama`.
2. `changes` says whether package jobs ran and why (`bundle`, main+code, or skipped).
3. `wllama` says `cache-hit`, `cache-miss`, `from-source`, or `verify-failed`.
4. A miss with no `scripts/wllama` / kick-file / package-action change usually means the key prefix moved or the cache expired (7 days).
5. Two compiles in parallel means the `wllama` job is missing and both package jobs built locally — that is a regression; restore the dedicated job.
6. `node scripts/ci-stats.ts` for p50/p95 against the SLOs.

## When CI is red

| Symptom                                       | What to do                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `bench-fixtures` cannot find a commit         | Shallow clone. The job needs `fetch-depth: 0`.                                                                                    |
| No CI on a PR, only labels/welcome            | Almost always a **merge conflict**. GitHub skips `pull_request` workflows until it is rebaseable. Draft vs ready is not the skip. |
| `Package chrome` green, `Package firefox` red | Firefox-only lint or source-zip rebuild. The wasm cache is already saved.                                                         |
| `range` (model pins) red, HTTP 429/5xx        | Transient Hugging Face. The checker retries twice. Re-run the job if it still failed. HTTP 403/size mismatch is a real pin drift. |
| `checks` red                                  | Real test/lint failure. There is no test retry.                                                                                   |
| Tag `Release` red on unit tests               | Confirm `fetch-depth: 0` is still on that job.                                                                                    |

## Quality that must stay on PRs

These run on every PR (including drafts, once the PR is mergeable):

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm bench:equality --check`, `pnpm test:e2e`
- `node scripts/wllama/build.ts --check`
- Chrome zip, worker smoke test, Firefox `web-ext lint`, second-build compare, and source-zip rebuild **when zip inputs change**; on `main`, also when any non-docs code changes

Assertions are not weakened. Live model benches stay out of CI.

## Rollback

Revert the workflow/action commits on `main`. The previous cache prefix `wllama-<hash>` may still be warm for a few days; `wllama-v2-` will miss once after a revert if that revert restores the old key. Shipping artifacts are unchanged: this PR only changes how CI builds and caches them.
