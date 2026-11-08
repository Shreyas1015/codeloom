# Contributing

Thanks for helping improve codeloom.

## Repo layout

```text
packages/cli/          # the codeloom package: CLI, indexer, linker, MCP server, dashboard server
packages/core/         # file map, tree-sitter parsing, layers (vendored from Understand Anything, MIT)
packages/dashboard/    # the dashboard (React + Vite), bundled into the cli package
packages/tree-sitter-*-wasm/   # extra grammars
fixtures/demo-shop/    # a small web + api workspace used by tests, CI and the e2e smoke
fixtures/evals/        # labelled apps for the accuracy gate
scripts/release/       # release build and the tarball install test
e2e/                   # Playwright smoke against the real dashboard server
```

Only `packages/cli` is published, as `codeloom`. The other packages are bundled into it.

## Set up

You need Node 22.13 or newer (for pnpm 11) and git. codeloom itself runs on Node 20 or newer.

```sh
corepack enable
pnpm install
pnpm build
```

## Check your change

```sh
pnpm typecheck
pnpm test                 # unit tests, including the accuracy gate on fixtures/evals
pnpm e2e                  # Playwright smoke (Chromium, 127.0.0.1 only)
pnpm release:build        # build the package the way it is published
pnpm release:pack-test    # pack it, install the tarball with plain npm, drive the installed CLI
```

CI runs all of these on Linux and macOS, on Node 20 and 22.

## Rules that tests enforce

- **The docs are the contract.** Every command, flag, MCP tool and prompt must be in `docs/reference.md`, and
  everything the README or the reference names must exist. Keep the README short: details go in `docs/`.
  After editing the root `README.md`, rewrite the npm page copy:
  `CODELOOM_UPDATE_DOCS=1 pnpm --filter codeloom test docs`.
- **Accuracy.** A change that drops precision below 95% or recall below 80% on any eval app fails CI. When
  you add a framework or pattern, add a labelled case under `fixtures/evals`.
- **No AI and no network in the indexer.** The only network call is the opt-in trace check.

## Pull requests

- Keep each PR to one change and say why in the description.
- Add a line to `CHANGELOG.md` under the next version.
- Conventional Commits are welcome (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), but not required.

## Releasing (maintainers)

1. Bump `packages/cli/package.json` and date the `CHANGELOG.md` entry, in a PR.
2. Once it is merged and CI passes, tag it: `git tag -a v0.4.0 -m "codeloom 0.4.0" && git push origin v0.4.0`.
3. The Release workflow builds, runs the tarball install test and publishes to npm with provenance, after you
   approve the `npm` environment. Then write the GitHub release notes from the CHANGELOG.

Follow [Semantic Versioning](https://semver.org).
