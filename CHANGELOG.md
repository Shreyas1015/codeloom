# Changelog

## 0.4.0 — unreleased

PR review maps, for public GitHub repos:

- Every pull request can get a short codeloom block in its description: a summary line, a Mermaid diagram
  of the chains it touches (changed stops marked ✏️), a journey/spec table, and the changed files on no
  journey. `codeloom review --base <ref>` renders it locally (paste it into a PR yourself); `codeloom init
  --github` installs two workflows that do it on every push and clean up when the PR closes.
- A link in that block opens a hosted, read-only snapshot of the dashboard for that PR, on GitHub Pages —
  nothing runs on a server. `codeloom snapshot --base <ref> --out <dir>` writes it: the dashboard's data at
  that diff, plus (unless `--data-only`) the dashboard itself and `review.md`. `codeloom snapshot-site`
  is the workflow's trusted publish step.
- New dashboard screen "This PR": counts, affected journeys with changed stops in ochre, a code panel with
  Change / Code now / Code before tabs and a diff view, and a "Comment on GitHub" link per stop. A snapshot
  banner marks every screen read-only. Static snapshot mode detects itself from `data/manifest.json`, reads
  `data/<key>.json` beside `index.html` instead of calling a server, and switches to hash routing so a
  reload or a direct link works with no server-side routing at all.
- Security: the publish workflow only ever trusts `data/*.json` and `review.md` from a PR's own (untrusted)
  build — it builds the hosted site and the PR block itself, from codeloom's own install, so no code or
  markup from the PR ever reaches the published page.
- Scope: a workspace that is the repo itself (`codeloom.workspace.json` at the git root, repos as
  subfolders); several separate git repos in one workspace are still out of scope.

## 0.3.1 — 2026-11-08 (GitHub release and npm)

Security fixes and a shorter README:

- Security: the 10 regexes CodeQL flagged in the file map's parsers (`js/polynomial-redos`) no longer take
  polynomial time on hostile input. Replies are read with string search, and a Makefile line with no colon or
  a Markdown file of unclosed brackets stays fast, with the same results as before.
- Docs: the README is short; the full reference (commands, MCP tools and prompts, the workspace file, the
  trace check) is in `docs/reference.md`, with `docs/how-it-works.md` and `docs/guide.md` beside it.
- Repo: SECURITY.md, CONTRIBUTING.md and a code of conduct. Releases are published to npm from GitHub Actions
  through trusted publishing, with provenance.

## 0.3.0 — 2026-11-08 (GitHub release and npm)

Specs per journey and views Claude can make:

- Spec candidates: `codeloom index` finds, with no AI and no network, the docs that name a journey's routes,
  pages, tables, queues or code (whole words; `:id`, `{id}` and `[id]` treated alike) and the ticket keys
  (like `SHOP-12`) in the commits that touched its files. Written to `.codeloom/spec-candidates.json`
  (committed, deterministic). The workspace file gains optional `specs` settings: extra or ignored doc globs,
  the ticket pattern and ignored key prefixes.
- Spec links: Claude confirms which candidates really describe a journey, each with a reason, in
  `.codeloom/specs.json` (committed, team-shared). Saving none records "checked, no spec".
- Views: Claude builds dashboard pages from a fixed set of widgets (counts, journeys, map, progress, checks,
  spec coverage, markdown note) and saves them to `.codeloom/views/<id>.json`. A `home` view replaces Home;
  a broken one falls back to the built-in Home with a notice, and never breaks the dashboard.
- MCP: `match_specs`, `save_spec_links`, `list_specs`, `save_view`, `list_views`, `delete_view` tools and
  `match-specs`, `make-view` prompts.
- Dashboard: a spec badge per journey (Spec linked, Spec candidates, No spec, Spec not checked) on Home,
  the Journey nameplate and views; a Spec filter on Home; a Specs tab on the Journey screen (linked docs and
  tickets with Claude's reason, or the candidates with their evidence, and docs read in place); Spec coverage
  on Progress; `/views/<id>` and a Views list in the rail. Specs and views update live. The dashboard never
  writes either; view notes never render raw HTML.
- CLI: `codeloom views list` and `codeloom views reset <id>` (`reset home` brings back the built-in Home).
  `codeloom doctor` checks `specs.json` and every view file.
- Ranking: a doc term many journeys share (a `customers` table) counts for little, and docs naming only
  tables or queues come last; a ticket whose commits touched many journeys' files counts for less.
  `match_specs` on a journey saved since the last index computes its candidates on the spot.
- Safety: spec doc links, snippets and the dashboard's code and doc views share one path check (inside the
  repo after symlinks; never `.git`, `.env*` or `.codeloom`, in any letter case). Ticket patterns are at most
  100 characters with no nested quantifiers or backreferences; keys inside longer tokens
  (`ORD-MH-26-001`) and `TC`, `AC`, `ADR`, `QA`, `ID` keys are ignored. Git never fetches in a partial clone.
- Views: the journeys widget's spec filter takes `unchecked`; `none` means checked with no spec, as on Home.

## 0.2.0 — 2026-11-06 (on main; not tagged separately)

Tours and progress (v0.2b):

- Guided tours: Tour mode in the dashboard walks one journey in four parts (Flow, Data journey, File notes,
  Check yourself), with each stop's code beside its explanation and ← / → between stops. Tours are committed
  in `.codeloom/tours/<journey id>.json`; a stop whose file changed is marked "may be out of date". Stops are
  matched by lane, repo, file and symbol, not line, so a line added above a stop never makes it "Removed".
- Progress: seen → toured → understood per journey, kept in `~/.codeloom/progress/` (never committed).
  Only a passed `check-me` marks a journey understood; when its code changes it needs a re-walk of just the
  changed stops. New Progress screen, understood % on Home, a progress strip per journey and the level on the
  Journey screen; the Continue band resumes your next tour stop. A journey that needs a re-walk counts as
  toured, not understood, everywhere (including `get_progress`). The progress file is locked while it is
  written, so the dashboard and your agent never lose each other's updates.
- MCP: `build_tour_context`, `save_tour`, `get_progress`, `record_check` tools and `write-tour`, `check-me`
  prompts.
- The dashboard's only writes: `POST /api/progress/seen` and `POST /api/progress/toured` (same token and
  127.0.0.1 rules). `GET /api/tours/:id` never sends the check's expected answers.
- `codeloom doctor` checks the progress and tour files, warns about a tour for a journey that no longer
  exists, and lists progress kept under the same workspace name before its repo set changed (never moved).
- `/api/code` never serves `.codeloom` files (a tour holds the check's expected answers).

Map accuracy (v0.2a):

- `graph.json` has method nodes and `calls` edges checked by codeloom's own resolver, each `exact` or `param`;
  tree-sitter edges outside JS/TS are kept as `unverified`.
- More UI code reaches its page: class components, Redux `connect` and thunks, RTK Query, namespaced and
  array-returning hooks, functions passed as arguments, and HTTP clients through barrel re-exports.
- Calls to other services are shown as external targets; `codeloom check` lists them.
- Mongoose `new Model().save()`, `connection.model()` and CommonJS model exports.
- Bundled or minified files are kept on the map but not analysed; `.claude/` and `.cursor/` are ignored.

## 0.1.0 — 2026-11-04 (GitHub release; not yet on npm)

First release.

- `codeloom init`, `index`, `check`, `doctor`, `dashboard` and `serve` commands.
- Maps a repo, or a folder of repos, into request chains: UI page → API route → handler → database table
  or queue, with `exact` / `param` / `guess` confidence on every hop and unresolved hops listed with a reason.
- Supports Next.js and React Router pages; fetch, axios, ky, got, superagent and wrapper functions; Express,
  Fastify, NestJS, Next.js API routes and AdonisJS; Prisma, Drizzle, TypeORM, Knex, Lucid, Mongoose and raw SQL;
  RabbitMQ (amqplib).
- Manual links and repo hints (`role`, `apiBase`) in `codeloom.workspace.json`.
- `codeloom check --traces`: compare the map with traces from Grafana Tempo or an OTLP JSON file.
- MCP server with 15 tools and 2 prompts (`name-journeys`, `verify-journey`).
- Read-only local dashboard: Home, Journey and Map screens.
- Re-indexes after each commit through a git post-commit hook.
- No AI, no telemetry; the only network call is the opt-in Tempo trace check.
