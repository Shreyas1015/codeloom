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

## The workflow files

`codeloom init --github` writes these two files, with `{{version}}` already replaced by the codeloom
version you ran. They are reproduced here to copy by hand, if you would rather not run `init --github`:

### `.github/workflows/codeloom-review-build.yml`

```yaml
# codeloom PR review map — build step (untrusted: runs the PR's own code and workflow file).
# Installed by "codeloom init --github"; see docs/pr-review-maps.md. Do not give this workflow write
# access to the repo — the publish half (codeloom-review-publish.yml) is what writes anything.
name: codeloom review build

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

concurrency:
  group: codeloom-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Look for a codeloom workspace
        id: workspace
        run: |
          if [ -f codeloom.workspace.json ]; then
            echo "found=1" >> "$GITHUB_OUTPUT"
          else
            echo "no codeloom.workspace.json at the repo root; nothing to snapshot"
          fi

      - name: codeloom index
        if: steps.workspace.outputs.found == '1'
        run: npx -y codeloom@<version> index

      - name: codeloom snapshot
        if: steps.workspace.outputs.found == '1'
        env:
          BASE_REF: ${{ github.base_ref }}
        run: |
          mkdir -p snapshot
          npx -y codeloom@<version> snapshot --base "origin/$BASE_REF" --out snapshot --data-only || touch snapshot/failed

      - uses: actions/upload-artifact@v4
        if: steps.workspace.outputs.found == '1'
        with:
          name: codeloom-snapshot
          path: snapshot/
          retention-days: 3
```

### `.github/workflows/codeloom-review-publish.yml`

```yaml
# codeloom PR review map — publish step (trusted: never checks out or runs the PR's own code).
# Installed by "codeloom init --github"; see docs/pr-review-maps.md. It clones the repo's default
# branch (never the pull request's own ref), then switches to (or creates) the "gh-pages" branch —
# nothing from the PR's own checkout or workflow file reaches the published site or the PR description.
name: codeloom review publish

on:
  workflow_run:
    workflows: ["codeloom review build"]
    types: [completed]
  pull_request_target:
    types: [closed]

# Scoped per PR (or, for a fork PR with no same-repo pull_requests entry, per source branch): a global
# group would let GitHub's "one pending run per group" rule cancel one PR's pending publish because
# another PR just queued one. No cancel-in-progress — a half-finished push is worse than a late one.
concurrency:
  group: codeloom-pages-${{ github.event.pull_request.number || github.event.workflow_run.pull_requests[0].number || github.event.workflow_run.head_branch }}

jobs:
  publish:
    # Only for the build's own pull_request runs (never some other workflow of the same name, and
    # never a run GitHub cancelled outright — cancelled carries no usable conclusion to act on).
    if: github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'cancelled' && github.event.workflow_run.event == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      actions: read
      pages: read
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Download the build artifact
        id: download
        uses: actions/download-artifact@v4
        continue-on-error: true
        with:
          name: codeloom-snapshot
          path: artifact
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ github.token }}

      # mode=skip: the build ran (conclusion success) but uploaded nothing, because it found no
      # codeloom.workspace.json — spec §6 says the PR shows nothing, so this job does nothing either.
      # mode=failed: the build itself failed before it could upload anything, or it uploaded a
      # snapshot/failed marker (its own "codeloom snapshot" step failed). mode=data: a normal
      # snapshot was uploaded.
      - name: Decide what to do
        id: mode
        env:
          CONCLUSION: ${{ github.event.workflow_run.conclusion }}
          DOWNLOAD_OUTCOME: ${{ steps.download.outcome }}
        run: |
          if [ "$DOWNLOAD_OUTCOME" != "success" ]; then
            if [ "$CONCLUSION" = "success" ]; then MODE=skip; else MODE=failed; fi
          elif [ -f artifact/failed ]; then
            MODE=failed
          elif [ "$CONCLUSION" = "success" ]; then
            MODE=data
          else
            MODE=failed
          fi
          echo "mode=$MODE" >> "$GITHUB_OUTPUT"

      # Resolves and validates the PR this build ran for, straight from the triggering event — never
      # from the artifact. A same-repo PR's number comes with the event; a fork PR's does not, so it's
      # looked up by head commit instead, filtered to exactly one open PR whose head is that commit and
      # whose head repo matches (never an old, merged PR that happens to share the commit). Either way
      # the result is re-checked against the PR's live state, since it may have closed or moved on since
      # the build started. Anything that doesn't resolve to exactly one open, matching PR is logged and
      # skipped (valid=0) — never a hard failure.
      - name: Find and validate the pull request
        id: pr
        if: steps.mode.outputs.mode != 'skip'
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          HEAD_SHA: ${{ github.event.workflow_run.head_sha }}
          HEAD_REPO: ${{ github.event.workflow_run.head_repository.full_name }}
          EVENT_PR_NUMBER: ${{ github.event.workflow_run.pull_requests[0].number }}
        run: |
          PR="$EVENT_PR_NUMBER"
          case "$PR" in '' | *[!0-9]*) PR="" ;; esac

          if [ -z "$PR" ]; then
            CANDIDATES=$(gh api "repos/$REPO/commits/$HEAD_SHA/pulls" | jq --arg sha "$HEAD_SHA" --arg repo "$HEAD_REPO" \
              '[.[] | select(.state == "open" and .head.sha == $sha and .head.repo.full_name == $repo) | .number]')
            if [ "$(echo "$CANDIDATES" | jq 'length')" = "1" ]; then PR=$(echo "$CANDIDATES" | jq '.[0]'); else PR=""; fi
          else
            READ=$(gh pr view "$PR" --repo "$REPO" --json state,headRefOid 2>/dev/null || echo '{}')
            STATE=$(echo "$READ" | jq -r '.state // empty')
            SHA=$(echo "$READ" | jq -r '.headRefOid // empty')
            if [ "$STATE" != "OPEN" ] || [ "$SHA" != "$HEAD_SHA" ]; then PR=""; fi
          fi

          case "$PR" in
            '' | *[!0-9]*)
              echo "no single open pull request matches commit $HEAD_SHA; skipping" >&2
              echo "valid=0" >> "$GITHUB_OUTPUT"
              exit 0
              ;;
          esac
          echo "number=$PR" >> "$GITHUB_OUTPUT"
          echo "head_sha=$HEAD_SHA" >> "$GITHUB_OUTPUT"
          echo "valid=1" >> "$GITHUB_OUTPUT"

      # Only HTTP 404 means "not enabled"; any other error (a transient API problem, a permissions
      # quirk) assumes Pages IS enabled, so a glitch here never adds a false "enable Pages" note.
      - name: Check GitHub Pages is enabled
        id: pages
        if: steps.mode.outputs.mode != 'skip' && steps.pr.outputs.valid == '1'
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
        run: |
          if OUT=$(gh api "repos/$REPO/pages" 2>&1); then
            echo "enabled=1" >> "$GITHUB_OUTPUT"
          elif echo "$OUT" | grep -q "HTTP 404"; then
            echo "enabled=0" >> "$GITHUB_OUTPUT"
          else
            echo "::warning::could not confirm whether GitHub Pages is enabled; assuming it is: $OUT"
            echo "enabled=1" >> "$GITHUB_OUTPUT"
          fi

      - name: Current PR description
        if: steps.mode.outputs.mode != 'skip' && steps.pr.outputs.valid == '1'
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ steps.pr.outputs.number }}
        run: gh pr view "$PR" --repo "$REPO" --json body -q .body > body.txt

      # No "ref:" — checkout then defaults to this (the publish) workflow's own trigger context, which
      # for workflow_run is the base repo's default branch, never the pull request's head. The clone
      # (with its origin remote and push credentials, courtesy of actions/checkout) lands in ./gh-pages,
      # so the rest of this job keeps its own working directory for the artifact and site/; the
      # gh-pages branch is then checked out (or created, orphaned, the first time) inside that same
      # already-authenticated clone, so the later push needs no extra credential setup.
      - name: Checkout the repo (for its gh-pages branch)
        if: steps.mode.outputs.mode != 'skip' && steps.pr.outputs.valid == '1'
        uses: actions/checkout@v4
        with:
          path: gh-pages
          fetch-depth: 0

      - name: Switch to gh-pages, creating it the first time
        if: steps.mode.outputs.mode != 'skip' && steps.pr.outputs.valid == '1'
        working-directory: gh-pages
        run: |
          if git ls-remote --exit-code --heads origin gh-pages >/dev/null 2>&1; then
            git fetch -q origin gh-pages
            git checkout -q gh-pages
          else
            git checkout -q --orphan gh-pages
            git rm -rqf . >/dev/null 2>&1 || true
            touch .nojekyll
            git add .nojekyll
            git commit -q -m "codeloom: create gh-pages"
          fi

      # Never fails the step itself: a refused artifact (exit 1) still has to update the PR from
      # whatever codeloom wrote to site/ (never gh-pages) and then fail the job visibly — see the last
      # step. "--previous" is always passed in the failed-build branch; a missing or invalid
      # gh-pages/pr-$PR/data/manifest.json (e.g. this PR's very first build failed) is tolerated.
      - name: Build the review site
        id: build_site
        if: steps.mode.outputs.mode != 'skip' && steps.pr.outputs.valid == '1'
        env:
          MODE: ${{ steps.mode.outputs.mode }}
          PAGES_ENABLED: ${{ steps.pages.outputs.enabled }}
          OWNER: ${{ github.repository_owner }}
          NAME: ${{ github.event.repository.name }}
          REPO: ${{ github.repository }}
          PR: ${{ steps.pr.outputs.number }}
          HEAD_SHA: ${{ steps.pr.outputs.head_sha }}
          RUN_URL: ${{ github.event.workflow_run.html_url }}
        run: |
          LINK="https://$OWNER.github.io/$NAME/pr-$PR/"
          PAGES_FLAG=""
          [ "$PAGES_ENABLED" = "0" ] && PAGES_FLAG="--pages-disabled"
          set +e
          if [ "$MODE" = "failed" ]; then
            npx -y codeloom@<version> snapshot-site --failed "$RUN_URL" --previous "gh-pages/pr-$PR/data/manifest.json" --link "$LINK" $PAGES_FLAG --body body.txt --out site
          else
            npx -y codeloom@<version> snapshot-site --data artifact/data --out site --head "$HEAD_SHA" --pr "$PR" --repo "$REPO" --link "$LINK" $PAGES_FLAG --body body.txt
          fi
          CODE=$?
          set -e
          echo "exit_code=$CODE" >> "$GITHUB_OUTPUT"

      # Only ever copies what codeloom itself wrote to site/ (this codeloom version's own dashboard
      # assets plus data/, never anything read directly from the untrusted artifact/), and only for a
      # normal snapshot that was actually hosted — never for a failed-build block (mode=failed, which
      # has no site/data to publish) and never for a refused artifact (exit_code != 0).
      - name: Publish the site to gh-pages
        if: steps.mode.outputs.mode == 'data' && steps.pr.outputs.valid == '1' && steps.build_site.outputs.exit_code == '0'
        env:
          PR: ${{ steps.pr.outputs.number }}
        run: |
          rm -rf "gh-pages/pr-$PR"
          mkdir -p "gh-pages/pr-$PR"
          for entry in site/*; do
            base="$(basename "$entry")"
            case "$base" in
              review.md|body.md|comment.md) continue ;;
            esac
            cp -r "$entry" "gh-pages/pr-$PR/"
          done

      - name: Commit and push gh-pages
        if: steps.mode.outputs.mode == 'data' && steps.pr.outputs.valid == '1' && steps.build_site.outputs.exit_code == '0'
        working-directory: gh-pages
        env:
          PR: ${{ steps.pr.outputs.number }}
        run: |
          git config user.name "codeloom[bot]"
          git config user.email "codeloom[bot]@users.noreply.github.com"
          touch .nojekyll
          git add .nojekyll "pr-$PR"
          if git diff --cached --quiet; then
            echo "nothing changed for pr-$PR"
          else
            git commit -q -m "codeloom: PR #$PR review map"
            PUSHED=0
            for attempt in 1 2 3; do
              if git push origin gh-pages; then
                PUSHED=1
                break
              fi
              git pull --rebase origin gh-pages
            done
            if [ "$PUSHED" != "1" ]; then
              echo "failed to push gh-pages after 3 tries" >&2
              exit 1
            fi
          fi

      # Runs for mode=failed or mode=data (never mode=skip: nothing was built, so there is nothing to
      # say). Pushed to gh-pages first (above), so by the time the PR points at the hosted link, that
      # link already works. body.md and comment.md are not mutually exclusive: over GitHub's body
      # limit, codeloom writes both (body.md: the description with the block removed; comment.md: the
      # block itself, upserted by finding codeloom's own earlier comment by its start marker).
      - name: Update the pull request
        if: steps.mode.outputs.mode != 'skip' && steps.pr.outputs.valid == '1'
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ steps.pr.outputs.number }}
        run: |
          if [ -f site/body.md ]; then
            gh pr edit "$PR" --repo "$REPO" --body-file site/body.md
          fi
          if [ -f site/comment.md ]; then
            ID=$(gh api "repos/$REPO/issues/$PR/comments" --paginate --slurp \
              --jq 'add | map(select(.user.login == "github-actions[bot]" and .body != null and (.body | startswith("<!-- codeloom:review:start -->")))) | .[0].id // empty' \
              | head -1)
            if [ -n "$ID" ]; then
              gh api --method PATCH "repos/$REPO/issues/comments/$ID" -F body=@site/comment.md
            else
              gh api --method POST "repos/$REPO/issues/$PR/comments" -F body=@site/comment.md
            fi
          fi

      # The PR already got its "refused" block above; this just makes the run itself show red, so a
      # refusal is not silently green.
      - name: Fail the run if codeloom refused the artifact
        if: steps.mode.outputs.mode == 'data' && steps.pr.outputs.valid == '1' && steps.build_site.outputs.exit_code != '0'
        env:
          EXIT_CODE: ${{ steps.build_site.outputs.exit_code }}
        run: |
          echo "codeloom snapshot-site refused the build artifact (exit $EXIT_CODE); see the PR for why." >&2
          exit 1

  cleanup:
    if: github.event_name == 'pull_request_target'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      # A missing gh-pages branch (no PR on this repo ever published a snapshot) is fine — nothing to
      # clean up — so a failed checkout here does not fail the job.
      - name: Checkout gh-pages
        id: checkout_pages
        uses: actions/checkout@v4
        continue-on-error: true
        with:
          ref: gh-pages
          fetch-depth: 0

      - name: Remove the PR's review map
        if: steps.checkout_pages.outcome == 'success'
        env:
          PR: ${{ github.event.pull_request.number }}
        run: |
          case "$PR" in
            '' | *[!0-9]*)
              echo "pull_request.number is not a plain integer: $PR" >&2
              exit 1
              ;;
          esac
          git config user.name "codeloom[bot]"
          git config user.email "codeloom[bot]@users.noreply.github.com"
          git rm -rq --ignore-unmatch "pr-$PR"
          if git diff --cached --quiet; then
            echo "nothing to remove for pr-$PR"
          else
            git commit -q -m "codeloom: remove PR #$PR review map"
            PUSHED=0
            for attempt in 1 2 3; do
              if git push origin gh-pages; then
                PUSHED=1
                break
              fi
              git pull --rebase origin gh-pages
            done
            if [ "$PUSHED" != "1" ]; then
              echo "failed to push gh-pages after 3 tries" >&2
              exit 1
            fi
          fi
```

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
  for cleanup) never checks out or runs the pull request's own code: it clones the repo's own default
  branch (never the pull request's ref), then switches to (or creates) the `gh-pages` branch inside that
  same clone. It downloads the build artifact and installs codeloom from npm itself at the version pinned
  in the workflow — so no HTML or script from the pull request ever reaches `<owner>.github.io`. The PR
  number and head commit come from the triggering event, never from the artifact: `workflow_run`'s own
  payload for a same-repo PR, or — for a pull request from a fork, where that payload has no PR entry — a
  lookup of the PR by its head commit, filtered to exactly one open PR whose head matches. Either way, the
  result is re-checked against the PR's own live state before anything is written; a run GitHub cancelled,
  or whose PR cannot be resolved this way, is skipped.
- Before anything in the build artifact is trusted, `codeloom snapshot-site` validates it: only
  `data/*.json`, no symlinks, no file over 5 MB, no total over the size cap, every file valid JSON, and
  `manifest.json`'s head must match the triggering event's own head SHA. Anything else is refused, and the
  pull request shows only "codeloom review map refused: `<reason>`" — nothing else from the artifact is
  used.
- Everything in the dashboard and the PR block is rendered as text (no raw HTML), with every label
  escaped — nothing in a snapshot or a PR block can inject markup or script.
- Untrusted values that reach a shell script (like the base branch name) are always passed through `env:`,
  never interpolated straight into a `run:` step.
