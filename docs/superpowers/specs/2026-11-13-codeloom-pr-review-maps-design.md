# codeloom PR review maps — hosted snapshot per pull request (design)

Date: 2026-11-13 · Status: approved by the author in brainstorming · Builds on 0.3.1 (main).
Covers the BRIEF's "Review Maps on PRs" (CodeSee's review maps), for **public GitHub repos** first.

Goal: every pull request gets (1) a short codeloom block in its description, with a Mermaid diagram of what the
change touches, and (2) a link to a hosted, read-only snapshot of the dashboard for that PR, where a reviewer can
click a changed stop and read its code diff. Nothing runs on a server: the snapshot is static files on GitHub Pages.

## 1. Flow

```
PR opened / pushed
  ├─ workflow "codeloom-review-build"   (on: pull_request · permissions: contents: read)
  │    checkout PR head (fetch-depth: 0) → npx codeloom@<v> index
  │    → npx codeloom@<v> snapshot --base <merge-base> --data-only --out snapshot/
  │    → upload artifact "codeloom-snapshot" (data/*.json only)
  └─ workflow "codeloom-review-publish" (on: workflow_run of the build · permissions: contents: write,
       pull-requests: write · concurrency: codeloom-pages)
       download artifact → validate (§5) → npx codeloom@<v> snapshot-site --data <dir> --out site/ --pr <n>
       → commit site/ to branch gh-pages at pr-<n>/ → update the PR description block (§4) from site/review.md
PR closed → the publish workflow (on: pull_request_target closed, no checkout of PR code) deletes pr-<n>/
```

URL: `https://<owner>.github.io/<repo>/pr-<n>/`. Each push replaces that folder. `<n>` comes from the
`workflow_run` / `pull_request_target` event payload, never from the artifact.

## 2. CLI

- `codeloom review --base <ref> [--format markdown|json] [--link <url>]`: the impact of `merge-base(<ref>, HEAD)..HEAD`
  (the existing `impact_of_diff` with a range) rendered as the PR block (§4). Local use: you or Claude paste it into
  a PR description. `--link` adds the "Open the full review map" line.
- `codeloom snapshot --base <ref> --out <dir> [--max-size 25MB] [--data-only]`: writes `<dir>/data/*.json` and,
  unless `--data-only`, the dashboard assets (`index.html`, `assets/…`) set to static mode and `review.md`.
- `codeloom snapshot-site --data <dir> --out <dir> [--pr <n>] [--link <url>]`: the publish workflow's trusted half
  (§5): validates `data/`, copies this codeloom version's dashboard assets next to it, fills `pr` into the manifest,
  and writes `review.md` from `data/review.json` with the same renderer as `codeloom review`.
- `codeloom init --github`: also writes `.github/workflows/codeloom-review-build.yml` and
  `codeloom-review-publish.yml`, pinned to the running codeloom version. Docs carry the same YAML to copy.
- The CLI's docs contract (README + `docs/reference.md`) covers the new commands and flags.

Scope: a workspace that is the repo itself (`codeloom.workspace.json` at the repo root; repos may be subfolders).
A workspace of several separate git repos is out of scope (CI has only the PR's repo).

## 3. Snapshot contents

`data/` holds the dashboard's API answers, computed once at the PR head by the same handlers the server uses:

- `manifest.json`: `{ version: 1, codeloom, repo, pr?, head, base, builtAt, files: [...] }`. `pr` is filled in by the
  publish step.
- Always: `overview`, `journeys`, every `journeys/<id>`, `chains` (default listing), `layers` per repo, every
  `tours/<id>`, `specs`, every `specs/<id>`, `views`, every `views/<id>`.
- `review.json`: the impact result (changed files with +/− counts, touched nodes, chains, journeys, tables, queues,
  files on no journey), plus for each changed function-like node the code **before** (at base) and **after** (at
  head) and its diff hunks.
- Map: `graph` for each repo at the top level and at every folder on the path to a changed file; `node/<ref>` for
  changed nodes and every stop of an affected journey.
- Code: the whole text of each file that holds a stop of an affected journey or a changed node, under the existing
  path checks (inside the repo after symlinks; never `.git`, `.env*`, `.codeloom`; ≤ the dashboard's code size cap).
- Docs: spec docs linked to affected journeys (same checks, ≤ 512 KB each).
- Never: progress (`~/.codeloom`), live events, search.

Addressing: a shared `snapshotKey(path, params)` (path + sorted query string) names each file
(`data/<key>.json`), used by both the writer and the dashboard. `/api/code` is special: the dashboard loads the
whole-file JSON and slices the requested lines itself.

Size: the writer stops adding Map folders and code files (in that order) once `--max-size` (default 25 MB) would be
passed, and records what it left out in `manifest.json` (`omitted`). If the always-included part alone is over the
limit, `snapshot` exits 2 with the size; the PR block then says the map was too large to host (§6).

## 4. The PR description block

Between `<!-- codeloom:review:start -->` and `<!-- codeloom:review:end -->`, appended to the description the first
time and replaced in place after that; text outside the markers is never changed. If the result would pass GitHub's
body limit (65,536 characters), the block goes in a single codeloom comment instead (updated in place).

Contents (as in the approved mockup):
- Heading `🗺 codeloom review map` and one line: "This PR touches N journeys, N chains, N tables, N queues."
- A Mermaid `flowchart LR` of the affected chains: page → call → route → handler → … → table / queue, changed
  nodes marked ✏️ and styled. Labels are escaped (quotes, brackets, `|`, backticks, HTML). At most 30 nodes; beyond
  that "+N more — see the full map". With no journeys named yet, chains are shown instead.
- A table: journey · changed stops · spec state.
- "Not on any journey:" the changed files that reach no chain (up to 10, then "+N more").
- "→ Open the full review map" with the URL and the commit it was built for.

## 5. Security (public repos take PRs from strangers)

- The build workflow runs the PR's own workflow file (GitHub uses the PR's version for `pull_request`), so its
  artifact is untrusted. The publish workflow:
  - takes only `data/*.json` and `review.md` from it; any other path, any symlink, a file over 5 MB or a total over
    `--max-size` → refuse and say so in the block;
  - parses each JSON file and checks `manifest.json` (version, `head` = the event's head SHA);
  - builds the site with `codeloom snapshot-site` from the codeloom version it installs from npm itself, so no
    HTML or script from the PR reaches `<owner>.github.io`;
  - never checks out or runs PR code.
- The dashboard renders all snapshot data as text (React escaping; markdown notes already never render raw HTML).
- The PR block is rendered by the publish step from the validated `review.json`, with every label escaped; no
  markdown from the artifact is used.
- Workflow permissions are the least each step needs (§1); the codeloom repo's own settings (approval for outside
  contributors' workflows, allowed actions) stay as they are.

## 6. Failures

| Case | What the PR shows |
|---|---|
| No `codeloom.workspace.json` | Nothing; the build logs "no workspace" and exits 0. |
| `index` or `snapshot` fails | The block with the first error line, and the last good snapshot's link labelled with its commit. |
| Snapshot over the size limit | Summary + diagram + "too large to host (38 MB > 25 MB)". |
| GitHub Pages not enabled | Summary + diagram + one line on enabling Pages (Settings → Pages → branch `gh-pages`). |
| Artifact fails validation | Only "codeloom review map refused: <reason>" (the publish step has no trusted data to summarise). |
| No journeys or chains touched | "No journeys touched" + the changed files. |
| Push race on `gh-pages` | One retry after rebase; then the run fails visibly. |
| PR closed | `pr-<n>/` removed; a missing folder is fine. |

## 7. Dashboard: static mode and "This PR"

- Static mode: chosen at load from `data/manifest.json` beside `index.html`. `apiGet` reads `data/<key>.json`;
  `apiPost`, live events and search are off; a missing file shows "Not in this snapshot". The Progress screen and
  progress strips are hidden. A banner: "Snapshot of PR #12 · commit a41c9e2 vs main · read-only".
- New screen `/review`, the start page in a snapshot: counts (files, functions, journeys, tables, queues), affected journeys with
  "N stops changed" and spec pills, lanes with changed stops in ochre, changed files with +/−.
- Code panel on a stop: tabs **Change** (diff: added green, removed red; default for changed stops), **Code now**
  (default for unchanged stops), **Code before**. A note: "+4 −1 lines inside this function. Also on journey X."
  "Comment on GitHub ↗" opens the file in the PR's Files changed tab
  (`https://github.com/<owner>/<repo>/pull/<n>/files#diff-<sha256(path)>`).
- Design follows DESIGN.md (ochre = changed, existing lane colours); no new external load targets.

## 8. Testing

- CLI unit: `snapshotKey`; snapshot writer (included / excluded files, path checks, size cut order, `omitted`);
  `review` markdown + Mermaid against golden files, including escaping and the 30-node cap; the description splice
  (markers added once, replaced in place, outside text untouched, comment fallback over 65,536 characters);
  artifact validation (other paths, symlinks, sizes, bad JSON, wrong head SHA).
- Dashboard: static-mode client (key mapping, code slicing, "Not in this snapshot"), `/review` screen, code panel
  tabs and diff rendering.
- e2e (Playwright): snapshot of `fixtures/demo-shop` after a real commit that changes one service method, served
  as plain files; open `/review`, click the changed stop, see the diff; assert no request to `/api/`.
- Workflows: dry-run on a public test repo with a web + api app before release; then the codeloom repo uses them on
  its own PRs.

## 9. Not in this version

A workspace of several git repos; private hosting (Cloudflare Pages + Access); Bitbucket; a hand-written review
tour ("start here"); PR rules / checklists.
