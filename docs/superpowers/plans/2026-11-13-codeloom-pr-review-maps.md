# codeloom PR review maps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. UI tasks also use the `impeccable` skill. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-11-13-codeloom-pr-review-maps-design.md`: a codeloom block in every PR description and a hosted, read-only dashboard snapshot per PR on GitHub Pages.

**Architecture:** A `Review` model (built on the existing `impactOfDiff`) feeds a markdown + Mermaid renderer (`codeloom review`) and a snapshot writer that calls the dashboard's own `API_ROUTES` handlers once and saves each answer as `data/<key>.json`. A trusted `codeloom snapshot-site` step validates that data, adds this codeloom version's dashboard assets and writes the PR body. The dashboard gains a static mode (reads `data/`, hash routes, read-only) and a `/review` screen with a diff code panel. Two GitHub workflow templates (build, publish) wire it to PRs.

**Tech Stack:** TypeScript (Node ≥ 20), commander, vitest 4, React + TanStack Router/Query + Vite (dashboard), Playwright (e2e), GitHub Actions + GitHub Pages.

## Global Constraints

- Everything the v0.3 plan's constraints bind still binds: identity `Shreyas1015 <shreyas1234gurav@gmail.com>`; no work names or code; deterministic committed files; MCP responses < 1 MB; commit by path; never `git add .superpowers`; commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Nobody pushes to `main`.** Work on a branch; one PR to `main`; merge only after CI is green and the author says so.
- Scope: a workspace that **is** the repo (`codeloom.workspace.json` at the git root; repos may be subfolders). Multi-git-repo workspaces, private hosting, Bitbucket are out.
- Snapshot never contains progress (`~/.codeloom`), live events or search; code and docs only through the existing path checks (inside the repo after symlinks; never `.git`, `.env*`, `.codeloom`).
- Snapshot size cap default **25 MB** (`--max-size`); cut order: Map folders, then code files; record cuts in `manifest.omitted`.
- PR block lives between `<!-- codeloom:review:start -->` and `<!-- codeloom:review:end -->`; text outside is never changed; over **65,536** characters → a single codeloom comment instead.
- Mermaid diagram: at most **30** nodes, then "+N more — see the full map"; every label escaped.
- Publish step trusts **only** `data/*.json` from the build artifact: no other path, no symlinks, ≤ 5 MB per file, total ≤ `--max-size`, `manifest.head` = the event's head SHA. Dashboard assets always come from the codeloom version installed by the publish workflow.
- Dashboard: no raw HTML, no new external load targets (`check:dist` stays green), DESIGN.md tokens (ochre = changed).
- Docs contract: every new command and flag in `docs/reference.md` (the docs test enforces it); README gets one short "PR review maps" bullet + link.

## File map

| File | Responsibility |
|---|---|
| `packages/cli/src/review/types.ts` | `Review`, `ReviewJourney`, `ReviewNodeChange`, `ReviewFile` types |
| `packages/cli/src/review/build.ts` | `buildReview(start, base)`: impact + per-node before/after code + hunks + journeys/stops/specs |
| `packages/cli/src/review/mermaid.ts` | `renderMermaid(review, maxNodes)`, `escapeMermaidLabel(s)` |
| `packages/cli/src/review/markdown.ts` | `renderReviewMarkdown(review, opts)` → the PR block body |
| `packages/cli/src/review/pr-body.ts` | `splicePrBody(body, block)` → `{ body } \| { comment }` |
| `packages/cli/src/snapshot/key.ts` | `snapshotKey(path, params)` (mirrored in the dashboard; shared golden file) |
| `packages/cli/src/snapshot/write.ts` | `writeSnapshotData(start, opts)` → `SnapshotManifest` |
| `packages/cli/src/snapshot/validate.ts` | `validateSnapshotData(dir, opts)` for untrusted artifacts |
| `packages/cli/src/snapshot/site.ts` | `buildSnapshotSite(opts)`: validate → copy assets → manifest.pr → review.md → body.md/comment.md |
| `packages/cli/src/commands/review.ts`, `snapshot.ts` | CLI glue for `review`, `snapshot`, `snapshot-site` |
| `packages/cli/templates/github/codeloom-review-build.yml`, `codeloom-review-publish.yml` | workflow templates, `{{version}}` placeholder |
| `packages/cli/src/commands/init.ts` | `--github` writes the two workflows |
| `fixtures/snapshot-keys.json` | golden `snapshotKey` cases for both packages |
| `packages/dashboard/src/api/static.ts` | static-mode detection, `snapshotKey`, data loading, code slicing |
| `packages/dashboard/src/api/client.ts` | `apiGet` routes through static mode when active |
| `packages/dashboard/src/screens/review/*` | `/review` screen, `ReviewCodePanel` (Change / Code now / Code before) |
| `packages/dashboard/src/components/shell/SnapshotBanner.tsx` | the read-only banner |
| `e2e/review.spec.ts`, `e2e/workspace.ts` | snapshot e2e on a single-git-repo demo-shop |

## Waves

Wave 1 (parallel, worktrees): Task 1, Task 2. Wave 2 (parallel): Task 3 (needs 1, 2), Task 4 (needs 2's key golden file). Wave 3: Task 5 (needs 1's `Review` type and 4). Wave 4: Task 6. Wave 5: Task 7.
Each task: TDD; `pnpm -r typecheck`; `pnpm -r build`; `cd packages/cli && CI=1 npx vitest run --maxWorkers=3`; dashboard tests where touched; commit by path.

---

### Task 1: Review model + `codeloom review` (spec §2, §4)

**Files:** Create `packages/cli/src/review/{types,build,mermaid,markdown}.ts`, `packages/cli/src/commands/review.ts`, `packages/cli/test/review-*.test.ts`, `packages/cli/test/golden/review-*.md`. Modify `packages/cli/src/cli.ts`, `docs/reference.md`, `packages/cli/test/helpers.ts`.

**Interfaces — Produces:**
```ts
// review/types.ts
export interface ReviewHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } // lines keep their " ", "+", "-" prefix
export interface ReviewNodeChange {
  ref: string;            // graph node id, e.g. "function:app/services/customer_service.ts:CustomerService.create"
  repo: string; file: string; symbol: string;
  before: { start: number; end: number; text: string } | null; // null = new node
  after: { start: number; end: number; text: string } | null;  // null = deleted node
  hunks: ReviewHunk[];
  added: number; removed: number;
  journeys: string[];     // journey ids this node is a stop of
}
export interface ReviewFile { repo: string; file: string; added: number; removed: number; onJourney: boolean }
export interface ReviewJourney { id: string; name: string; changedStops: string[] /* refs */; spec: "linked" | "candidates" | "none" | "unchecked"; chains: string[] }
export interface Review {
  version: 1;
  base: string; head: string;           // full SHAs
  baseRef: string;                      // what the user passed, e.g. "origin/main"
  files: ReviewFile[];
  nodes: ReviewNodeChange[];
  journeys: ReviewJourney[];            // empty when none are named; then `chains` carries the chain ids
  chains: string[];
  tables: string[]; queues: string[];
  truncated: boolean; notes: string[];
}
// review/build.ts
export function buildReview(start: string, baseRef: string): Review;
// review/mermaid.ts
export function escapeMermaidLabel(s: string): string;
export function renderMermaid(review: Review, state: MapState, maxNodes?: number /* 30 */): string; // "```mermaid\nflowchart LR\n…\n```"
// review/markdown.ts
export interface ReviewMarkdownOptions { link?: string; builtFor?: string /* short SHA */; error?: string; tooLarge?: { bytes: number; max: number }; previous?: { link: string; builtFor: string } }
export function renderReviewMarkdown(review: Review | null, state: MapState | null, opts?: ReviewMarkdownOptions): string;
```
**Consumes:** `impactOfDiff(start, range)` and `functionExtents` (export it) from `src/mcp/tools/check.ts` (range = `${mergeBase}..HEAD`; merge-base via the existing `git()` util), `loadMapState(start)` and `journeysForChains(state, chainIds)` from `src/mcp/state.ts`, spec state from `listSpecs(start, {})` in `src/mcp/tools/specs.ts`.

- [ ] **Step 1: helper.** Add `materializeSingleRepo(name: string): string` to `packages/cli/test/helpers.ts`: copy `fixtures/<name>`, `git init -b main` **once at the root**, commit everything ("base"). Add `commitChange(root, file, edit: (text) => string, message)`.
- [ ] **Step 2: failing tests** `review-build.test.ts` on `materializeSingleRepo("demo-shop")` after `runIndex`, saving journeys with `saveJourneysTool(start, ops)` (`src/mcp/tools/journeys.ts`), then `commitChange` editing the body of `CustomerService.create` (add 3 lines, remove 1):
  - `files` has that file with `added: 3, removed: 1, onJourney: true`; a new `api/lib/gst.ts` → `onJourney: false`.
  - `nodes[0].ref` is the `CustomerService.create` function node; `before.text` / `after.text` differ exactly by the edit; one hunk; `journeys` lists the create-customer journey id.
  - `journeys` has `changedStops` = that ref and the journey's spec state; `tables` includes `customers`.
  - base passed as `main` resolves via merge-base when HEAD is on a branch two commits ahead.
  - not a git repo → `CodeloomError` with exit 2.
- [ ] **Step 3: run** `cd packages/cli && npx vitest run test/review-build.test.ts` → FAIL (module missing).
- [ ] **Step 4: implement `build.ts`.** Merge-base, `impactOfDiff(start, \`${mb}..HEAD\`)`, then per changed node: extents at base and head (reuse `functionExtents` — export it from check.ts), `git show base:file` / `git show HEAD:file` slices, hunks from `git diff --unified=0 base HEAD -- file` filtered to the node's line span (+3 context lines read from the texts). Journeys: `journeysForChains`; spec state from `listSpecs`.
- [ ] **Step 5: run** → PASS.
- [ ] **Step 6: failing tests** `review-markdown.test.ts`: golden `review-basic.md` (summary line, mermaid, table, "Not on any journey", link line); `escapeMermaidLabel` for `"`, `[`, `]`, `|`, `` ` ``, `<script>`; 45 nodes → 30 + `+15 more — see the full map`; no journeys named → chains table; no chain touched → "No journeys touched" + the changed files; `review === null` + `error` → only heading + error line; `opts.tooLarge = { bytes, max }` → summary + diagram + "Full map too large to host (38 MB > 25 MB)" and no link; `opts.previous = { link, builtFor }` with `error` → error line + "Last good map (a41c9e2): <link>"; deterministic (two renders identical).
- [ ] **Step 7: implement `mermaid.ts` + `markdown.ts`** (affected chains' stops in lane order page → call → route → handler → … → table/queue; changed nodes get `:::changed` with `classDef changed fill:#FBF0D6,stroke:#E3A72F,stroke-width:2px` and a ✏️ prefix; node ids `n1..nN` in first-seen order). Heading `### 🗺 codeloom review map`.
- [ ] **Step 8: CLI.** `codeloom review --base <ref> [--format markdown|json] [--link <url>]` in `commands/review.ts`, registered in `cli.ts`; json prints the `Review`. Add both to `docs/reference.md` (Commands table). Run docs test.
- [ ] **Step 9: run all cli tests**, typecheck → PASS. **Commit** `feat(review): Review model and codeloom review (PR block markdown + Mermaid)`.

### Task 2: Snapshot data writer + `snapshotKey` (spec §3)

**Files:** Create `packages/cli/src/snapshot/{key,write}.ts`, `fixtures/snapshot-keys.json`, `packages/cli/test/snapshot-{key,write}.test.ts`. Modify `packages/cli/src/web/api.ts` (export what the writer needs, no behaviour change).

**Interfaces — Produces:**
```ts
// snapshot/key.ts — byte-for-byte mirrored in packages/dashboard/src/api/static.ts
export function snapshotKey(path: string, params?: Record<string, string | number | undefined>): string;
// "/api/journeys/j_1" → "journeys~j_1"; params sorted by name, undefined dropped, values encodeURIComponent'd:
// ("/api/graph", {repo:"api", dir:"app/services"}) → "graph@dir=app%2Fservices&repo=api"
// any key longer than 120 chars → first 80 chars + "-" + sha256(key).slice(0,16); "/" in the path → "~"
export interface SnapshotManifest {
  version: 1; codeloom: string; head: string; base: string; builtAt: string;
  pr?: number; repoSlug?: string;          // filled by snapshot-site
  tooLarge?: { bytes: number; max: number }; // set when even the always-included part passes maxBytes: then only manifest + review are written
  files: string[];                         // data-relative paths, sorted
  omitted: { mapFolders: string[]; codeFiles: string[] };
  bytes: number;
}
// snapshot/write.ts
export interface WriteSnapshotOptions { baseRef: string; outDir: string; maxBytes?: number /* 25 MB */; now?: () => Date }
export function writeSnapshotData(start: string, opts: WriteSnapshotOptions): Promise<SnapshotManifest>; // writes outDir/data/*.json
```
**Consumes:** `API_ROUTES`, `matchRoute` (api.ts), `buildReview` (Task 1 — if not merged yet, write `review.json` from a stub and the controller reconciles), `repoFile` path check (export from api.ts).

- [ ] **Step 1: golden keys.** `fixtures/snapshot-keys.json`: 12 cases `{ path, params, key }` incl. a param with `/`, an undefined param, unicode, and a 200-char dir (hashed form).
- [ ] **Step 2: failing test** `snapshot-key.test.ts` iterates the golden file. Run → FAIL. Implement `key.ts`. Run → PASS.
- [ ] **Step 3: failing tests** `snapshot-write.test.ts` (single-repo demo-shop + one changed commit, as Task 1):
  - writes `overview`, `journeys`, every `journeys~<id>`, `chains`, `layers@repo=…` per repo, every `tours~<id>`, `specs`, every `specs~<id>`, `views`, every `views~<id>`, `review`, `manifest`.
  - `graph@repo=api` (top) and `graph@dir=app&repo=api`, `graph@dir=app%2Fservices&repo=api` (path to the changed file) exist; an unrelated folder does not.
  - `node~<ref>` for the changed node and each stop of affected journeys.
  - `docs@file=…&repo=…` for each spec doc linked to an affected journey (≤ 512 KB).
  - `files~<repo>~<path>` (`{ file, text }`) for each file holding such a stop; never for `.env`, a symlink out of the repo, or `.codeloom/*` (seed those in the fixture copy).
  - no `progress*` file, no `search*` file.
  - `maxBytes` set just under the full size → `omitted.mapFolders` non-empty first, code files kept; tighter → code files cut too; below the always-included size → only `manifest` (with `tooLarge: { bytes, max }`) and `review` are written, exit 0.
  - deterministic: two runs with the same `now` → identical bytes.
- [ ] **Step 4: implement `write.ts`:** a `get(path, params)` that builds a `URL`, `matchRoute(API_ROUTES, …)`, awaits the handler, JSON-stringifies (sorted keys not needed: handlers are deterministic), records size; always-set first, then Map folders, then code files, each added only while under the cap.
- [ ] **Step 5: run** → PASS. typecheck. **Commit** `feat(snapshot): write dashboard data for a PR snapshot`.

### Task 3: Trusted `snapshot-site`, PR body splice, relative dashboard base (spec §1, §2, §4, §5, §6)

**Files:** Create `packages/cli/src/snapshot/{validate,site}.ts`, `packages/cli/src/review/pr-body.ts`, `packages/cli/src/commands/snapshot.ts`, tests `snapshot-validate.test.ts`, `snapshot-site.test.ts`, `pr-body.test.ts`. Modify `packages/dashboard/vite.config.ts` (`base: "./"`), `packages/cli/src/web/server.ts` (inject `<base href="/">`), `packages/cli/src/cli.ts`, `docs/reference.md`.

**Interfaces — Produces:**
```ts
// review/pr-body.ts
export const START = "<!-- codeloom:review:start -->"; export const END = "<!-- codeloom:review:end -->";
export const GITHUB_BODY_LIMIT = 65_536;
export function splicePrBody(body: string, block: string): { body: string } | { comment: string };
// snapshot/validate.ts
export interface ValidateOptions { maxBytes: number; expectedHead: string }
export function validateSnapshotData(dataDir: string, opts: ValidateOptions): SnapshotManifest; // throws CodeloomError(reason) on: non-.json entry, subfolder, symlink, file > 5 MB, total > maxBytes, bad JSON, manifest.version !== 1, manifest.head !== expectedHead, a file not listed in manifest.files
// snapshot/site.ts
export interface SiteOptions { dataDir: string; outDir: string; expectedHead: string; maxBytes?: number; pr?: number; repoSlug?: string; link?: string; bodyFile?: string }
export function buildSnapshotSite(opts: SiteOptions): { reviewMd: string; body?: string; comment?: string; hosted: boolean };
// manifest.tooLarge → no assets copied, hosted: false, block says too large. Failed build mode:
export interface FailedSiteOptions { outDir: string; runUrl: string; previousManifest?: string /* gh-pages pr-<n>/data/manifest.json */; link?: string; bodyFile?: string }
export function buildFailedBlock(opts: FailedSiteOptions): { reviewMd: string; body?: string; comment?: string }; // error line with the run URL + last good link when previousManifest exists
```
CLI: `codeloom snapshot --base <ref> --out <dir> [--max-size <size>] [--data-only]` (no `--data-only` = data + `buildSnapshotSite` with `expectedHead` = HEAD); `codeloom snapshot-site --data <dir> --out <dir> --head <sha> [--pr <n>] [--repo <owner/name>] [--link <url>] [--body <file>] [--max-size <size>]` (or `--failed <run-url> [--previous <manifest>]` instead of `--data`/`--head`) writes `out/` (site), `out/review.md`, and `out/body.md` or `out/comment.md`. On a validation failure it still writes `review.md` = `renderReviewMarkdown(null, null, { error: "codeloom review map refused: <reason>" })` and exits 1.

- [ ] **Step 1: failing tests** `pr-body.test.ts`: empty body → `"\n\n" + START + block + END`; existing block replaced in place, text before/after byte-identical; two STARTs → only the first block replaced; result > 65,536 → `{ comment }`.
- [ ] **Step 2: implement**, run → PASS.
- [ ] **Step 3: failing tests** `snapshot-validate.test.ts`, one per rejection rule in the interface comment, plus a valid folder passes and returns the manifest.
- [ ] **Step 4: implement**, run → PASS.
- [ ] **Step 5: failing tests** `snapshot-site.test.ts`: `tooLarge` manifest → no assets, `hosted: false`, too-large line; `--failed` with and without a previous manifest → error line with the run URL, last good link only when present; assets copied from `locateDashboardAssets()`; `data/` copied; `manifest.pr` + `repoSlug` set; `review.md` rendered from `data/review~….json` with `link`; an artifact containing `index.html` or `assets/evil.js` → refused before anything is written to `outDir`; `--body` file spliced into `body.md`.
- [ ] **Step 6: implement `site.ts` + `commands/snapshot.ts`**, register both commands, add to `docs/reference.md`.
- [ ] **Step 7: relative base.** `vite.config.ts` `base: "./"`. In `server.ts`, when sending `index.html`, insert `<base href="/">` right after `<head>` (string replace once; test in `test/web-server.test.ts`: GET `/journeys/x` → HTML has the base tag, and `/assets/<file>` still serves). Rebuild dashboard; run `pnpm e2e` → existing specs PASS (deep links still load assets).
- [ ] **Step 8: run** cli + dashboard tests, `check:dist`. **Commit** `feat(snapshot): trusted snapshot-site, PR body splice, relative dashboard assets`.

### Task 4: Dashboard static mode (spec §7)

**Files:** Create `packages/dashboard/src/api/static.ts`, `packages/dashboard/src/components/shell/SnapshotBanner.tsx`, tests `test/static-mode.test.tsx`. Modify `src/api/client.ts`, `src/api/events.ts`, `src/router.tsx`, `src/main.tsx`, `src/components/shell/Rail.tsx`, Home/Journey progress pieces, search box.

**Interfaces — Produces:**
```ts
// api/static.ts
export interface SnapshotInfo { pr?: number; repoSlug?: string; head: string; base: string; builtAt: string; omitted: { mapFolders: string[]; codeFiles: string[] } }
export function snapshotKey(path: string, params?: Record<string, string | number | undefined>): string; // identical to cli/src/snapshot/key.ts
export async function detectSnapshot(fetchImpl?: typeof fetch): Promise<SnapshotInfo | null>; // GET ./data/manifest.json; 200 + version 1 → info
export function isSnapshot(): boolean;               // set once at boot by main.tsx
export async function staticGet<T>(path: string, params?: QueryParams): Promise<T>; // /api/code → loads files~… then slices like the server (CODE_MAX_LINES 400, CODE_MAX_CHARS 60000); missing file → NotInSnapshotError
export class NotInSnapshotError extends Error {}
```
**Consumes:** `fixtures/snapshot-keys.json` (Task 2).

- [ ] **Step 1: failing tests** `static-mode.test.tsx`: `snapshotKey` matches every case in `../../fixtures/snapshot-keys.json`; `staticGet("/api/journeys")` fetches `./data/journeys.json`; `/api/code` with start/end slices the stored text and matches the server's `CodeResponse` shape; missing → `NotInSnapshotError` → the screen shows "Not in this snapshot"; `apiPost` in static mode throws without a network call; `useMapEvents` opens no EventSource; Rail hides Progress; search input is hidden; banner text "Snapshot of PR #12 · commit a41c9e2 vs main · read-only".
- [ ] **Step 2: run** `pnpm --filter @codeloom/dashboard test static-mode` → FAIL.
- [ ] **Step 3: implement.** `main.tsx`: `await detectSnapshot()` before render; static → `createHashHistory()` passed to `createAppRouter`, default route `/review`. `client.ts` `apiGet`: `if (isSnapshot()) return staticGet(path, params)`. Hide progress strips/Understood/Progress route and search; `SnapshotBanner` above `<main>` content in the Shell.
- [ ] **Step 4: run** dashboard tests → PASS; `check:dist` → PASS. **Commit** `feat(dashboard): static snapshot mode (read-only, hash routes, data files)`.

### Task 5: `/review` screen + diff code panel (spec §7; mockups approved 2026-11-13)

**Files:** Create `packages/dashboard/src/screens/review/{ReviewScreen,ReviewCodePanel,diff}.tsx`, `src/routes/review.tsx`, `src/api/types.ts` additions (mirror `Review` from Task 1), tests `test/review-screen.test.tsx`. Modify `src/router.tsx`, `src/api/queries.ts` (`useReview()` → `staticGet("/api/review")`).

- [ ] **Step 1: failing tests:** counts row (files, functions, journeys, tables, queues); journey rows with "N stops changed" + spec pill; selecting a journey shows its lanes with changed stops styled `data-changed="true"`; clicking a changed stop opens `ReviewCodePanel` on **Change** with `+` lines in an element with role `insertion` and `-` lines with role `deletion`, and the note "+3 −1 lines inside this function. Also on journey …"; tabs **Code now** / **Code before** show `after.text` / `before.text`; an unchanged stop opens on **Code now**; "Comment on GitHub ↗" href = `https://github.com/<repoSlug>/pull/<pr>/files#diff-<sha256(repoPath)>` (use `crypto.subtle.digest`); files list with +/− and "not on a journey".
- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3: implement** with the `impeccable` skill, following the approved mockups (ochre wash + 2px ochre border for changed stops; diff colours: add `#E6F4EA`, delete `#FCE8E6`; existing `CodeBlock` for highlighting where it fits). Route `/review` registered only when `isSnapshot()`.
- [ ] **Step 4: run** dashboard tests, `check:dist` → PASS. **Commit** `feat(dashboard): This PR screen and diff code panel`.

### Task 6: GitHub workflows + `codeloom init --github` (spec §1, §5, §6)

**Files:** Create `packages/cli/templates/github/codeloom-review-build.yml`, `codeloom-review-publish.yml`, `docs/pr-review-maps.md`, test `init-github.test.ts`. Modify `packages/cli/src/commands/init.ts`, `src/cli.ts`, `packages/cli/package.json` (`files` += `templates/`), `scripts/release/pack-test.sh` (templates present), `packages/cli/test/release-manifest.test.ts`, `docs/reference.md`, `README.md` (+ npm copy).

Template contents (exact; `{{version}}` replaced by `init`):
- **build** — `on: pull_request` (opened, synchronize, reopened); `permissions: contents: read`; `concurrency: codeloom-review-${{ github.event.pull_request.number }}` cancel-in-progress; steps: `actions/checkout@v4` with `ref: ${{ github.event.pull_request.head.sha }}`, `fetch-depth: 0`; `actions/setup-node@v4` node 22; if no `codeloom.workspace.json` → echo and exit 0; `npx -y codeloom@{{version}} index`; `npx -y codeloom@{{version}} snapshot --base origin/${{ github.base_ref }} --out snapshot --data-only || touch snapshot/failed` (only the marker's presence is read; its content never is); `actions/upload-artifact@v4` name `codeloom-snapshot`, path `snapshot/`, retention 3 days.
- **publish** — `on: workflow_run` (workflows: ["codeloom review build"], types: completed) and `pull_request_target` (types: closed); `permissions: contents: write, pull-requests: write, actions: read`; `concurrency: codeloom-pages` (no cancel). Job `publish` (if `workflow_run`): never checks out PR code; `actions/checkout@v4` with `ref: gh-pages` (create orphan branch if missing); `actions/download-artifact@v4` with `run-id: ${{ github.event.workflow_run.id }}`; PR number from `github.event.workflow_run.pull_requests[0].number` (fork PRs: look it up with `gh api repos/$REPO/commits/$HEAD_SHA/pulls`); `gh pr view $PR --json body -q .body > body.txt`; if the build run did not succeed or `artifact/failed` exists → `npx -y codeloom@{{version}} snapshot-site --failed <build run URL> --previous gh-pages/pr-$PR/data/manifest.json --link … --body body.txt --out site` and only update the PR; else `npx -y codeloom@{{version}} snapshot-site --data artifact/data --out site --head ${{ github.event.workflow_run.head_sha }} --pr $PR --repo $REPO --link https://$OWNER.github.io/$NAME/pr-$PR/ --body body.txt`; replace `pr-$PR/` with `site/` (minus `review.md`, `body.md`, `comment.md`); commit + push to `gh-pages` (one `git pull --rebase` retry); `gh pr edit $PR --body-file site/body.md` or upsert the codeloom comment (`gh api` find by START marker); if Pages is not enabled (`gh api repos/$REPO/pages` 404) append the "enable Pages" line to the block. Job `cleanup` (if `pull_request_target` closed): checkout `gh-pages`, `git rm -r --ignore-unmatch pr-$PR`, commit, push.

- [ ] **Step 1: failing tests** `init-github.test.ts`: `runInit(dir, { github: true })` (extend `runInit(dir, opts: { bin?: string; github?: boolean })`) writes both files with the running version, keeps an existing customised file (reports "kept"), and the YAML parses (`yaml` devDependency) with the permissions above; build workflow never has `contents: write`; publish workflow never runs `actions/checkout` with the PR's ref.
- [ ] **Step 2: run** → FAIL. **Step 3: implement** templates + `--github` flag. **Step 4: run** → PASS.
- [ ] **Step 5: docs.** `docs/pr-review-maps.md` (what reviewers see, setup in 3 steps: `npx codeloom init --github`, enable Pages from branch `gh-pages`, push a PR; what is and is not in a snapshot; security model). `docs/reference.md` commands + flags. README "What you get" bullet "**PR review maps.** …" linking the doc; regenerate the npm README.
- [ ] **Step 6: release checks** — `pnpm release:build && pnpm release:pack-test` include the templates. **Commit** `feat(github): PR review map workflows and codeloom init --github`.

### Task 7: e2e, trial run, CHANGELOG, review

**Files:** Create `e2e/review.spec.ts`. Modify `e2e/workspace.ts` (single-git-repo demo-shop + change commit + `codeloom snapshot` into a temp dir, served by a tiny static file server on 127.0.0.1 that has **no** SPA fallback and no `/api`), `CHANGELOG.md` (0.4.0, unreleased).

- [ ] **Step 1: e2e** `review.spec.ts`: open `http://127.0.0.1:<port>/pr-12/` → lands on `#/review`; banner text; click the changed `CustomerService.create` stop → Change tab shows the added lines; Code before tab; open Home and a Journey via the rail; reload on `#/journeys/<id>` works; `page.on("request")` sees no URL containing `/api/`. Run `pnpm e2e` → PASS (all specs).
- [ ] **Step 2: trial run** (author approves creating it): a public test repo `Shreyas1015/codeloom-review-trial` with a copy of `fixtures/evals/realworld` as one git repo + `codeloom.workspace.json`; install the workflows from a local tarball build (`npm pack` → `npx -y ./codeloom-*.tgz` in the templates via a `CODELOOM_SPEC` env override documented only in the test repo); open a PR from a branch and one from a fork; check the PR block, the Pages URL, the diff panel, the fork artifact cannot publish HTML (add `snapshot/data/x.html` in the fork's build workflow → publish refuses), and cleanup on close.
- [ ] **Step 3: CHANGELOG** 0.4.0 entry (PR review maps; `review`, `snapshot`, `snapshot-site`, `init --github`).
- [ ] **Step 4: final whole-branch review** (`superpowers:requesting-code-review`), fix findings, full CI green on the PR. Merge only with the author's OK; release 0.4.0 through the tag + `npm` environment flow.
