# PR review maps

Every pull request gets a short codeloom block in its description, and a link to a hosted, read-only
dashboard snapshot on GitHub Pages where a reviewer can click a changed stop and read its code diff.
Nothing runs on a server: the snapshot is static files.

## What a reviewer sees

In the pull request description, between `<!-- codeloom:review:start -->` and
`<!-- codeloom:review:end -->` (or, when that block would be too big for GitHub's description limit, in a
single codeloom comment instead):

- A heading and one line: "This PR touches N journeys, N chains, N tables, N queues."
- A Mermaid diagram of the affected chains (page → call → route → handler → … → table / queue), changed
  nodes marked ✏️. Up to 30 nodes, then "+N more — see the full map".
- A table of the affected journeys, their changed stops and spec state.
- The changed files that reach no journey.
- "→ Open the full review map", linking to `https://<owner>.github.io/<repo>/pr-<n>/` — a static copy of
  the codeloom dashboard at this PR's head, opened on a `/review` screen built for this. Click a changed
  stop to see its diff (added/removed lines), its code now, or its code before. Nothing here is live:
  search and your own progress are turned off.

The block updates in place on every push, and `pr-<n>/` is removed when the PR closes.

## Setup

1. `npx codeloom init --github` — writes `.github/workflows/codeloom-review-build.yml` and
   `codeloom-review-publish.yml`, pinned to the codeloom version you ran. Commit and push them.
2. Enable GitHub Pages for the repo: **Settings → Pages → Build and deployment → Deploy from a branch →
   `gh-pages`**. (The first PR this runs on creates the `gh-pages` branch for you; you can enable Pages
   either before or after that.)
3. Open a pull request. The build workflow runs on `pull_request`; once it finishes, the publish workflow
   posts the block and, once Pages is live, the hosted link.

If a repo already has a `codeloom-review-build.yml` or `codeloom-review-publish.yml` you edited by hand,
`init --github` leaves it alone and tells you so — it never overwrites a customised workflow.

## What is (and is not) in a snapshot

A snapshot is the dashboard's own API answers, computed once at the PR's head commit, for the pull
request's repo only (a workspace that **is** the repo; `codeloom.workspace.json` at the git root):

- The usual screens: overview, journeys, chains, layers, tours, specs, views.
- `review.json`: the changed files, touched nodes, chains, journeys and tables/queues, and for each
  changed function the code before and after with its diff.
- The map (folders and files down to functions) for every repo, and the whole text of each file that
  holds a stop of an affected journey or a changed node — subject to the same path checks the dashboard
  always applies (inside the repo after symlinks; never `.git`, `.env*`, `.codeloom`).
- Spec docs linked to affected journeys.

**Never** in a snapshot: your own progress (`~/.codeloom`), live events, or search. A snapshot has a size
cap (default 25 MB, `--max-size`); if trimming the map and code files still leaves it over the cap, the PR
gets only the summary and diagram with a note that the map was too large to host.

## Security model

This is designed for a public repo that takes pull requests from strangers.

- **Build** (`codeloom-review-build.yml`, `on: pull_request`) runs the PR's own code and, since GitHub
  always uses the PR's version of a `pull_request`-triggered workflow file, its own workflow file too. It
  has `permissions: contents: read` and nothing else — no token that could write anything, anywhere. Its
  only output is an untrusted build artifact (`data/*.json`).
- **Publish** (`codeloom-review-publish.yml`, `on: workflow_run` of the build, plus `pull_request_target`
  for cleanup) never checks out or runs the pull request's own code. It only ever checks out the
  `gh-pages` branch, downloads the build artifact, and installs codeloom from npm itself at the version
  pinned in the workflow — so no HTML or script from the pull request ever reaches
  `<owner>.github.io`. The PR number and head commit come from the triggering event (`workflow_run`'s own
  payload, or — for a pull request from a fork, where that payload has no PR entry — a lookup of the PR by
  its head commit), never from the artifact.
- Before anything in the build artifact is trusted, `codeloom snapshot-site` validates it: only
  `data/*.json`, no symlinks, no file over 5 MB, no total over the size cap, every file valid JSON, and
  `manifest.json`'s head must match the triggering event's own head SHA. Anything else is refused, and the
  pull request shows only "codeloom review map refused: `<reason>`" — nothing else from the artifact is
  used.
- Everything in the dashboard and the PR block is rendered as text (no raw HTML), with every label
  escaped — nothing in a snapshot or a PR block can inject markup or script.
- Untrusted values that reach a shell script (like the base branch name) are always passed through `env:`,
  never interpolated straight into a `run:` step.
