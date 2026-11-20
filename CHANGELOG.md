# Changelog

## 0.6.0 — 2026-11-20 (GitHub release and npm)

Index each repo on its own; codeloom connects them into journeys across repos.

- **Index each repo.** `cd <repo> && npx codeloom index` works in any git repo, with no setup. Each repo joins a
  group in a registry on your machine (`~/.codeloom`, or `$CODELOOM_HOME`): repos with the same git host and
  owner form one group (`ssh.github.com`, `ssh.bitbucket.org` and the like count as their site), else the parent
  folder's name; `--group <name>` picks one. A repo is named by its remote's repo name, else its folder. After each index codeloom re-links the whole group from the other
  repos' saved maps (it never parses them again) and prints what got connected. Older checkouts of the same
  remote are ignored. `dashboard`, `serve`, `check` and `doctor` run inside any repo use its group. A
  workspace folder (`codeloom.workspace.json`) works as before.
- **A repo alone in its group** (another team's account, say) is pointed out, with the command to join the
  group its calls match when one clearly does.
- **Repos connect by themselves.** An env var, config key or host in a call's base that names one repo of the
  group (`BILLING_API_URL` → billing) sends the call there. A Next.js catch-all route that forwards to such a
  base works like a proxy rule, also when it forwards through a shared factory or helper in another file. Unclear
  names are never guessed: they become questions.
- **Service to service.** A backend's HTTP calls continue the chain into the other service's route, handler
  and tables. Long chains stop after a few hops and say where they continue (the dashboard links it).
- **AdonisJS v5 routes.** A string handler (`'CustomersController.index'`, `'Admin/CustomersController.index'`)
  finds its controller by Adonis's namespace (`.adonisrc.json`, or a group's or route's `.namespace()`),
  including `<Name>/index.ts` and a class named differently from its file. `Route.resource` (v5 and v6, with
  `only`, `except`, `apiOnly`) and `Route.route` give their routes. Routes registered by a function that
  another file calls inside `Route.group(...)` get that group's prefix and namespace. The chain continues into services called
  as static methods, through `new Service()` or through an imported instance (`export default new Service()`).
- **Queues across repos.** RabbitMQ publishers and consumers pair across repos, including calls through your
  own wrapper functions and classes, exchanges with routing keys (by the exchange's type) and handlers passed
  as `this.method`. Names that reach amqplib through base classes, subclass `super(...)` arguments and field
  overrides, `getInstance()` singletons and message objects are followed too; a queue name that is a runtime
  value becomes a question (`queue-unknown`), never a guess. `codeloom check` counts queue operations per repo.
- **Claude fixes the map with you.** `codeloom gaps` (MCP `map_gaps`) lists only what codeloom could not
  settle, as short questions with the evidence: a repo alone or not connected, call bases no repo is known for
  (also a backend's relative URLs and calls through its wrappers), calls matching no route, routes nothing
  calls, lonely queues, calls two repos could serve, proxy routes forwarding to a base no repo is known for,
  unclear roles. `codeloom ask` (or the `map-interview`
  prompt) goes through them with Claude, one question at a time; `save_map_answers` checks every name, saves
  the answer and re-links without parsing. `codeloom link` re-links after you edit answers by hand.
- **One command on a PR.** `codeloom pr` on a PR branch: indexes, builds the PR block (base `origin/main`, else
  `main`, else `master`), lets Claude check it under the same rules as `codeloom review --check` (asks first on a
  terminal, `--check` to skip the question, never without one of them; a review already saved for this head is
  reused, `--recheck` checks again), writes a local snapshot (in the workspace folder's or the group's `.codeloom/pr/`, never in the repo; the 5
  newest are kept), serves it on 127.0.0.1
  and opens the This PR page. It also prints the block for the PR description. In a group, the page shows the
  journeys across repos: the other repos' pages that reach the change and the services it calls. `--no-open`,
  `--port`, `--out`; `--repo` in a workspace folder.
- The This PR page opens on the summary: Checked by Claude (or Draft), what it does, where it matters, what it
  writes, before deploying, code to check (click a function for its diff) and notes. Snapshots carry it as
  `data/pr-summary.json`; a hosted snapshot rebuilds it from `review.json` and never trusts the PR's own copy.
- `codeloom snapshot --repo <id>`: a snapshot of one repo in a folder of repos (or of the repo you run it in).

Changes in behaviour:

- A manual link (in the workspace file or an answer) now also settles a call that matched only as a guess.
- `codeloom ask` asks before starting Claude, and the default answer is no.
- A repo's map stays in `<repo>/.codeloom/`; a group's chains, journeys, tours, views and answers live in
  `~/.codeloom/groups/` (or under `$CODELOOM_HOME`). `.codeloom/` is added to the repo's `.git/info/exclude`.
- Your 0.5 data carries over: the first time a repo indexed on its own joins a group, its journeys, tours,
  views, specs and your progress are copied into the group.
- An exchange declared two different ways matches the same routing key only.
- `codeloom check`: a route another service calls counts as having a caller. The text says "N/M routes have a
  caller (X from UI, Y from services)" and lists "Routes with no caller"; in `--json`, a `route-no-caller` item's
  detail is "… has no caller" (was "has no UI caller"), the summary gains `routesWithServiceCaller` (when > 0) and
  the report gains `queues: [{ repo, publish, consume }]` (when some repo uses a queue).
- `codeloom check` on a big map stays short: info-only items (calls that could not be resolved, calls to other
  services) are counted per repo with 5 examples (`--verbose` lists them all); `--json` keeps at most 200 items of
  each kind and counts the rest in `truncated` (`--all` keeps everything).
- Test, e2e, load-test and mock files (`tests/`, `e2e/`, `cypress/`, `__mocks__/`, `*.spec.ts`, …) are never the
  start of a journey and are not counted by `check` or the gaps.
- No guessed link without a shared literal path segment, and none between two repos' equally specific routes:
  those become questions.
- The map's questions skip a call base whose name already places it, and propose a repo for a base only when it
  serves at least 70% of the base's matched calls (otherwise they show the split).
- A method called on something imported from a package (`Event.emit()`, `Mail.send()`), or on a field
  of a library-typed value (`const { response } = ctx`), is no longer guessed onto a same-named repo method.
  Your own workspace packages and bare imports of your folders still are, and so is a field the repo
  exports under the same name (`const { customerService } = req` on a decorated Request).

## 0.5.0 — 2026-11-17 (GitHub release and npm)

PR reviews you can read, set up in one step:

- `codeloom init` is a guided setup: it picks one checkout per repo (duplicates of the same remote are
  unticked), asks whether to commit codeloom's files or keep them local (`.git/info/exclude`, no hooks),
  builds the map, connects Claude Code when it is installed and offers to open the dashboard. `--yes` takes
  the defaults and never starts Claude or the dashboard. Run again, it offers only what is missing (and to
  update an older pinned Claude Code entry, which `codeloom doctor` now recognises as codeloom's own).
- `codeloom review` writes a plain draft from facts, with no AI: where the change matters (entry points,
  named by journey), what the changed code writes (and what it only reads), ⚠ before deploying (migration,
  schema, env, Docker and CI files), the changed functions to check and a small diagram of the changed path.
  `--repo <id>` reviews one repo in a folder of repos; the 0.4 layout is `--format full`.
- Claude checks the draft: `codeloom review --check` (or the `check-pr` prompt) sends Claude a small packet
  (at most 24,000 characters: the draft, the changed lines, the commit messages). Claude writes "What it
  does", may replace "Where it matters" and may add items or notes; the facts codeloom detected (writes,
  risks, changed functions) always stay. `save_pr_review` refuses names that
  are not in the packet. The run is isolated: no built-in tools, only codeloom's save tool. codeloom asks
  before starting Claude.
- Workspace `proxies`: a UI repo whose calls go through its own proxy route (`/api/core/*`) is linked to the
  backend repo's real routes. Generated API clients built by a local factory (`backendClient('core')`) are
  followed too.
- Reading code: knex queries through Lucid (`knexQuery().table(Model.table)…`) are database reads and writes.

## 0.4.1 — 2026-11-16 (GitHub release and npm)

- Fix: a function or class named like a built-in object member (`valueOf`, `toString`, `constructor`, …)
  made `codeloom index` write a `graph.json` that codeloom's own checks then refused, so `check`, the
  dashboard and the MCP tools failed for that repo. Such names now get an empty summary like any other.

## 0.4.0 — 2026-11-13 (GitHub release and npm)

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
- Security: the publish workflow only ever trusts `data/*.json` from a PR's own (untrusted)
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
