# codeloom — design spec

Date: 2026-10-30 · Status: draft for author review · Author: Shreyas Gurav (with Claude)

Background research lives in `docs/BRIEF.md`. Product truth lives in `PRODUCT.md`. The visual
direction contract lives in `.impeccable/surfaces/dashboard.md`. Approved mockups:
`.impeccable/mocks/screens/codeloom-screens.html`.

---

## 1. What we are building

**codeloom** (npm name, free as of 2026-10-30) is an open-source npm package that:

1. Maps a codebase, or a workspace of several repos, **without AI** (tree-sitter).
2. Finds **user journeys** across repos: UI page → user action → API route → handler → service → DB table.
3. Gives the map to Claude or any agent through **MCP**; the agent names journeys, writes summaries and
   tours, and judges "Check yourself" answers.
4. Shows it all in a local **dashboard** built for learning a codebase, with honest progress tracking.

Primary user: the author, in 20–60 minute deep-dive sessions. Built to be general: any repo, any team,
open-sourced later. Shopfront is only the real-world test bed; nothing Shopfront- or company-specific ships.

### The author's 7 requirements and where they land

| # | Requirement | Where | Version |
|---|---|---|---|
| 1 | Home: totals (files, routes, pages, tables, journeys) + the journey list | Home screen, §6 | v0.1 |
| 2 | Click a journey → FE + BE + DB connected | Linker §3, Journey screen §6 | v0.1 |
| 3 | Per tour / feature: spec present or not; works on any codebase | `match_specs` §5, SpecBadge §6; adapters §3 | v0.3 (spec), v0.1 (adapters) |
| 4 | Change the dashboard through Claude; author's layout is the default | Views §4–§6 | v0.3 |
| 5 | Knowledge graph for each attached repo | Workspace + per-repo graph §2, Map §6 | v0.1 |
| 6 | Friendly, fun UI; CodeSee-like connectors; tour phases | Gallery Guide direction, Tour mode §6 | v0.1 look, v0.2 tours |
| 7 | Progress: tours done, journeys understood, what is left per service | Progress §4–§6 | v0.2 |

### Decisions made (with date 2026-10-29/30)

| Topic | Decision |
|---|---|
| Name | `codeloom` |
| Journey detection | Code finds the chains (no AI); Claude groups and names them; the user can edit |
| Multi-repo | Workspace file in a parent folder of local clones; each repo keeps its own graph |
| "Understood" | Three levels: seen → toured → understood (passed 3 check questions judged by the agent) |
| Re-walk | Understanding goes stale when code under a journey changes after it was understood |
| Specs | Repo markdown docs + ticket keys from commits/branches; states: spec found / ticket only / none |
| Dashboard customisation | Views built from ready-made widgets, stored as JSON Claude can edit; custom code panels later |
| Architecture | One Node package, JSON files in `.codeloom/` (team) and `~/.codeloom/` (personal) |
| Dashboard stack | React + Vite + TypeScript, shadcn/ui + Tailwind, TanStack Router + Query, React Flow, Shiki |
| Not used | Next.js (static export would switch off its strengths), FastAPI/Python (breaks `npx` install) |
| Visual direction | Gallery Guide (Impeccable roll, seed:3975335602dccf63), CodeSee is a feature model only |
| Understand Anything | Fork (vendor) `packages/core`; keep MIT notice; it is not published to npm, so depending is impossible |

---

## 2. Architecture

```
<workspace folder>/                 e.g. ~/Developer/shopfront
├─ codeloom.workspace.json          repos, manual links, name
├─ .codeloom/                       workspace-level team data (journeys, tours, views)
├─ repo-a/.codeloom/                per-repo team data (graph, endpoints, summaries)
└─ repo-b/.codeloom/
~/.codeloom/                        personal data, never committed (progress, settings)
```

A single repo works the same way: the repo is its own workspace and no workspace file is needed.

### Parts (all inside the one published package)

| Part | Job | Reads / writes |
|---|---|---|
| **indexer** | tree-sitter parse per repo: files, functions, classes, imports, calls, layers, UI pages, HTTP calls, routes, DB access, queues. Incremental via fingerprints. | writes `graph.json`, `endpoints.json` |
| **linker** | Matches UI calls to routes across repos, follows handlers to tables and queues, builds chain skeletons | reads all repos' endpoints + graphs; writes `journeys.json` |
| **store** | Typed read/write of every file, zod validation, atomic writes, file watching, change events | used by all parts |
| **mcp** | MCP server (stdio default, HTTP optional): tools + prompts, §5 | store |
| **web** | Local HTTP server on 127.0.0.1: JSON API, SSE change stream, serves the prebuilt dashboard | store |

### Commands

| Command | Does |
|---|---|
| `codeloom init` | Detect repos (current folder or children), write `codeloom.workspace.json` / `.codeloom/config.json`, install post-commit hook, add MCP entry to `.mcp.json` |
| `codeloom index [--repo x]` | Index changed files, then re-link |
| `codeloom dashboard` | Start web server on a free port with a session token, open the browser |
| `codeloom serve` | Start the MCP server |
| `codeloom doctor` | Check and repair data files, hooks, MCP entry |

### Rules

- No AI and no API keys inside the package. No telemetry. No network calls except opening the browser.
- MCP and the dashboard share one store, so agent writes show up live in the dashboard.
- Team knowledge is committed (`.codeloom/`); personal progress is not (`~/.codeloom/`).

### Repo layout (pnpm monorepo)

```
packages/
  core/        forked Understand Anything core (types, tree-sitter, fingerprints, search, layers)
  cli/         published as `codeloom`: indexer, linker, store, mcp, web, commands
    src/adapters/   one folder per framework/ORM adapter (§3)
  dashboard/   Vite app, built to static files and bundled into cli at publish
fixtures/      demo workspace for tests (§7)
docs/          BRIEF.md, specs, plans
LICENSE (MIT, ours) · NOTICE (Understand Anything MIT notice + upstream commit 9545eb5)
```

Only `packages/cli` is published; `core` and the built dashboard are bundled into it.

---

## 3. How journeys are found

A journey is a chain: **UI page → user action → API call → route → handler → service → DB table**,
plus queue hops where present.

### Step 1 — find endpoints per repo (adapters)

| Side | Detects | v0.1 adapters |
|---|---|---|
| UI pages | file-based pages and router definitions | Next.js (app + pages), React Router |
| UI → HTTP | `fetch`, `axios`, `ky`, react-query hooks, custom API-client wrappers followed through the call graph | generic JS/TS |
| Routes | method + path + handler, including group prefixes | AdonisJS, Express, NestJS, Fastify, Next.js API routes |
| DB access | model/ORM calls and raw SQL, mapped to tables and to read / insert / update / delete | Lucid, Knex, Prisma, Drizzle, TypeORM, raw SQL |
| Tables | migrations, schema files, model definitions (incl. naming conventions) | same as DB access |
| Queues | publish ↔ consume on literal queue names | RabbitMQ (amqplib) |

Adapters implement one interface and are plug-ins. Next: Django, FastAPI, Rails, Spring, Go. Unknown
stacks still get the full code map; only automatic journeys are missing (agent can build them via MCP).

### Step 2 — link across repos

- Normalise URLs: strip env base URLs, turn template params into `:param` (`${API}/customers/${id}` →
  `/api/customers/:id`).
- Match on method + path. Each hop gets a confidence: `exact`, `param`, or `guess`.
- From each handler, follow calls (max depth 6) to DB or queue access.

### Step 3 — skeleton chains

- Every UI action that reaches a route is one chain. Backend-only entry points (cron, queue consumers,
  CLI commands) are chains without a UI lane.
- Default name without an agent: `POST /api/customers · CustomerProfilePage`.

### Step 4 — agent groups and names

- `list_chains` → agent → `save_journeys`: merge related chains into one journey with name, area, one-line
  note. The user can rename / merge / split in the dashboard or by asking the agent.
- Journey IDs are stable (hash of entry point + route), so names survive re-indexing. If the code behind a
  journey disappears, the journey is flagged `orphaned`, not deleted.

### Honesty rules

- Unresolved hops (e.g. URL built at runtime) are shown as dashed "couldn't resolve" links with the reason.
- The user can add a manual link once in `codeloom.workspace.json` (`links: [{ from, to }]`).
- Home counts come from this step: files, routes, UI pages, tables, journeys.

---

## 4. Data files

All files carry `"version"` and are validated with zod. Writes are atomic (temp file + rename). Bad
files are reported with a `codeloom doctor` hint, never silently overwritten.

### Per repo — `<repo>/.codeloom/` (committed)

| File | Content | Writer |
|---|---|---|
| `graph.json` | Understand Anything `KnowledgeGraph` format: nodes, edges, layers | indexer |
| `endpoints.json` | UI pages, HTTP calls, routes, tables, queue publish/consume | indexer |
| `fingerprints.json` | Per-file fingerprints for incremental indexing | indexer |
| `summaries.json` | Plain-English summaries per node id | agent via MCP |
| `config.json` | Ignore rules, adapter overrides, `autoUpdate` | `init` / user |

### Workspace — root (committed, or local if the user prefers)

| File | Content |
|---|---|
| `codeloom.workspace.json` | `name`, `repos: [{ id, path, role? }]`, `links: []` manual hops |
| `.codeloom/journeys.json` | chains, journeys (`id`, `name`, `area`, `note`, `stops[]` with lane/node/confidence, `chainIds`, `status`), spec + ticket links (v0.3) |
| `.codeloom/tours/<journeyId>.json` | v0.2: per stop explanation, Data Journey (sample in / SQL / sample out), traps, 3 check questions |
| `.codeloom/views/<id>.json` | v0.3: `{ title, widgets: [{ type, ...options }] }`; `home.json` is the default |

### Personal — `~/.codeloom/` (never committed)

| File | Content |
|---|---|
| `progress/<workspaceId>.json` | per journey: `seenAt`, `touredAt`, `understoodAt`, `understoodAtCommit`, per-stop file hashes at that time, check history |
| `settings.json` | UI preferences |

**Re-walk rule:** a journey is `needs re-walk` when any stop's file hash differs from the hash stored at
`understoodAt`. Only the changed stops must be re-walked to restore "understood".

Graphs over 10 MB print a git-lfs tip.

---

## 5. MCP tools and prompts

### Read the map (v0.1)

| Tool | Returns |
|---|---|
| `workspace_overview` | repos, counts, index freshness |
| `search` | files, functions, routes, tables, journeys by name (fuzzy) |
| `get_node` | location, summary, edges, journeys it belongs to |
| `get_neighbors` | callers / importers and dependencies, depth 1–3 |
| `get_layers` | layers per repo |
| `explain_context` | code + neighbours + layer + journeys, packed for explanation |
| `impact_of_diff` | working tree or `base..head` → changed nodes, affected journeys and tables |
| `index_status` / `reindex` | staleness vs HEAD, skipped files; re-index |

### Journeys (v0.1)

| Tool | Does |
|---|---|
| `list_chains` | unnamed chains with per-hop confidence |
| `save_journeys` | create / merge / split / rename journeys |
| `get_journey` | stops per lane, files, tables, unresolved hops |
| `trace_route` | from a route, page or table, follow up and down the stack |
| `save_summary` | store a summary for a node |

### Tours and progress (v0.2)

| Tool | Does |
|---|---|
| `build_tour_context` | code per stop, types, SQL, sample shapes for the agent to write a tour |
| `save_tour` | store the tour (explanations, Data Journey, traps, 3 questions) |
| `get_progress` | seen / toured / understood per journey, repo, area; needs re-walk |
| `record_check` | store questions, user answers, agent verdict, commit; the only way to set "understood" |

### Specs and views (v0.3)

| Tool | Does |
|---|---|
| `match_specs` | candidate docs and ticket keys per journey, for the agent to confirm |
| `save_view` / `list_views` | create or change dashboard views |

### Prompts (ship with the server)

`/codeloom:name-journeys` · `/codeloom:write-tour <journey>` (replaces the `feature-tour` skill, backed by
the map) · `/codeloom:check-me <journey>`.

### Rules

- Write tools go through the store and its validation; invalid input returns a clear error.
- "Understood" cannot be set without `record_check`.

---

## 6. Dashboard

### Stack

React + Vite + TypeScript · shadcn/ui + Tailwind · TanStack Router + Query · React Flow · Shiki.

### Routes

| Route | Screen | Version |
|---|---|---|
| `/` | Home: count strip, Continue band, journey table (filters, search, sort) | v0.1 |
| `/journeys/:id` | Journey: header, tabs, UI / API / DB lanes, stop inspector | v0.1 |
| `/map?repo=&overlay=` | Map: folder → file → function canvas, overlays, inspector | v0.1 |
| `/journeys/:id/tour?phase=&stop=` | Tour mode: Flow → Data journey → File notes → Check yourself | v0.2 |
| `/progress` | per repo / area, needs re-walk, recent checks | v0.2 |
| `/views/:id` | widget preview, prompt history, view file | v0.3 |

The approved mockups for all six are in `.impeccable/mocks/screens/codeloom-screens.html`.

### Data flow

- `codeloom dashboard` → server on `127.0.0.1:<free port>` with a session token → opens browser.
- JSON API: `/api/overview`, `/api/journeys`, `/api/journeys/:id`, `/api/graph?repo=`, `/api/node/:id`,
  `/api/progress`, `/api/views/:id`.
- SSE `/api/events`: store change → TanStack Query invalidates only affected keys.
- Map loads one repo at a time and expands folders on demand.

### Look (Gallery Guide, see `.impeccable/surfaces/dashboard.md`)

- Tokens in shadcn CSS variables: viridian rail `#1F4D45`, gallery-white ground `#F3F4F1`, ink `#1A1D1C`,
  ochre stops `#E3A72F`, lanes UI `#2F5E9E` / API `#1F4D45` / DB `#8A5A2B`, oxblood `#B5483D` only for
  "no spec" and errors.
- Schibsted Grotesk for UI; JetBrains Mono only for code, paths, SQL.
- Custom components: `StopRoundel`, `ProgressStrip`, `SpecBadge`, `LaneColumn`, `CountStrip`.
- Keyboard: j/k through journeys, ←/→ through tour stops; visible focus; contrast checked with
  Impeccable's detector; reduced motion respected. Light theme in v0.1; dark later.
- Final design finish: Impeccable finish review and `DESIGN.md` written from the built UI.

### States

Not indexed (command + progress) · no journeys found (fallback to Map + "ask the agent" hint) · agent
not connected (setup line) · index older than HEAD (re-index banner) · unresolved hops (dashed).

---

## 7. Testing, errors, acceptance

### Testing

| Layer | Approach |
|---|---|
| Adapters | unit tests on code snippets per framework |
| Linker | fixture workspace (Next.js UI + AdonisJS API + Express/Prisma API), expected journeys as snapshots |
| Store | validation, atomic writes, old versions, concurrent writers |
| MCP | contract tests via the MCP SDK client: every tool, valid + invalid input |
| Dashboard | Vitest + Testing Library components; Playwright smoke tests for Home, Journey, Map on the fixture |
| Real world | manual run on the author's repos before release; not in CI; nothing stored |

CI: GitHub Actions, Node 20 + 22, macOS + Linux, and a tarball install test (`npm pack`).

### Errors

Unparseable file → skipped and listed · unresolved hop → dashed with reason · bad data file → message +
`codeloom doctor` · busy port → next free port · no agent → setup hint.

### v0.1 acceptance criteria

1. `npx codeloom init` in a folder of repos detects them, writes the workspace file, adds the post-commit
   hook and the `.mcp.json` entry.
2. `codeloom index` on the fixture finds the expected pages, routes, tables and chains with zero AI calls;
   a re-run after one commit re-parses only changed files.
3. On the author's real multi-repo workspace, a known journey links UI → API → DB correctly, and
   unresolved hops are shown honestly.
4. In Claude Code, `/codeloom:name-journeys` names chains and the dashboard updates live.
5. `codeloom dashboard` shows Home, Journey and Map matching the approved mockups, with empty, loading
   and not-indexed states.
6. CI green; tarball installs and runs; UA notice included. **npm publish only after the author approves.**
7. `codeloom check` prints the chain-health report on the fixture and on the author's workspace (§7a), and
   the answer-key accuracy tests meet the targets in CI.

---

## 7a. Evaluating the map (added 2026-10-30, author-approved; built in Plan 2)

How we know a chain is right, without AI.

### 1. `codeloom check` — chain-health report (no answer key needed)

| Check | Problem example | Where the chain breaks |
|---|---|---|
| Frontend calls matched to a route | `POST /api/customerz` has no backend route | UI → API |
| Routes whose handler resolves to code | `CustomersController.store` not found in the graph | API → code |
| Routes that reach a DB table or queue | `GET /reports` touches no table | code → DB |
| URLs that could not be read | `fetch(url)` built at runtime | unresolved |
| Routes no UI calls | `DELETE /customers/:id` | backend-only, or a missed call |

- Summary line, e.g. "41 journeys: 33 complete UI → API → DB, 5 missing the DB step, 3 broken at UI → API".
- Every item lists repo, file and line. `--json` for machines; exit code 0 always (it is a report, not a gate)
  unless `--fail-under <percent>` is given.
- MCP tool `check_chains` returns the same report; the dashboard draws the same items as dashed links.

### 2. Accuracy against an answer key (CI)

- Hand-written expected journeys (`fixtures/<name>/expected-journeys.json`) for the demo-shop fixture and
  2–3 public open-source apps (vendored as fixtures at a pinned commit, licence-compatible).
- Per hop type (UI→API, route→handler, handler→table/queue): precision and recall.
- v0.1 targets: **precision ≥ 95%**, **recall ≥ 80%**. Wrong links are worse than missing ones (missing
  links show honestly as dashed). CI fails when a target is missed.

### 3. Confidence on every hop

`exact` (same literal path), `param` (matched a `:param` template or after base-URL/mount-prefix
normalisation), `guess` (suffix or fuzzy match). `guess` is drawn dashed and never presented as fact.

### 4. Runtime check with OpenTelemetry — optional, only if available

- If the user configures a trace source (`codeloom.workspace.json` → `traces: { kind: "tempo", url }` or
  `{ kind: "otlp-file", path }`), `codeloom check --traces` reads recent spans (HTTP server spans with
  `http.route` / `url.path`, DB spans with `db.sql.table` / `db.statement`, messaging spans) and compares
  them with the static map: hops **confirmed by traffic**, hops **seen in traffic but missing from the map**
  (a missed link), and routes **never hit** in the window.
- If no trace source is configured or reachable, the step is skipped with one line saying so; nothing else
  changes. This is the only network call codeloom makes, and only to the user's own endpoint.
- Grafana Tempo first (author's stack); any OTLP JSON export works through the file option.

### 5. Agent spot-check (optional, second opinion)

MCP prompt `/codeloom:verify-journey <journey>` lets the agent read the code of each hop and flag doubts.
It never changes confidence on its own; it only adds a note.

---

## 8. Roadmap

| Version | Delivers |
|---|---|
| v0.1 | workspace, indexer, linker, journey skeletons, MCP read + journey tools, dashboard Home / Journey / Map |
| v0.2 | tours (Data Journey, traps, checks), progress with re-walk, Tour + Progress screens |
| v0.3 | spec + ticket matching, Views via the agent |
| v0.4 | PR Review Maps + rules (Bitbucket first, then GitHub), notes and labels, ownership |
| after v0.1 ships (author idea, 2026-11-01) | **Self-improving eval loop ("codeloom gym")** — see §8a |
| later | service-level map beyond HTTP/queues, OpenTelemetry trace overlay, DB-aware hot queries, weekly quiz, hosted sharing, VS Code extension, dark theme |

## 8a. Self-improving eval loop — "codeloom gym" (planned after v0.1)

Author idea (2026-11-01): keep codeloom the best tool for developers by testing it on a steady stream of real open-source
repos, and improving it week by week.

- **Corpus:** a scheduled job (daily) picks open-source repos by category (full-stack app, API-only, monorepo, SPA,
  microservices) and language/stack (Next.js, React Router, Express, NestJS, Adonis, Fastify, Prisma, TypeORM, Drizzle,
  RabbitMQ; later Python/Go), licence-checked (MIT/Apache) and pinned by commit.
- **Run:** `codeloom index` + `codeloom check` on each, no AI in the run itself.
- **Signals (ground truth matters):**
  1. Answer-key apps (like `fixtures/evals`): precision/recall per hop type — the hard gate.
  2. Self-check health on every repo: chains complete %, unresolved-call rate, routes with no UI caller, calls reaching
     no page, guess-link share — tracked as trends (they show coverage gaps without needing a key).
  3. Optional OTel traces where a repo ships a demo with tracing — confirmed vs missing links.
  4. New keys: an agent drafts answer keys for sampled repos, a human (or a second agent) reviews before they count.
- **Weekly report:** scores and trends per category/stack, the top failure patterns (e.g. "wrapper HTTP clients in
  Vue apps"), new regressions, and a proposed fix list — each pattern turned into an adapter/linker task with a
  regression test from the real repo.
- **Guardrails:** thresholds never lowered to pass; every fix lands with a test from the repo that exposed it;
  repos stored as trimmed, licensed copies or pinned SHAs; runs are offline except the clone step.
- **Likely shape:** a `codeloom-gym` workspace or CI job (scheduled cloud routine), a `codeloom eval` command, and a
  committed `evals/history/` of weekly reports.

## 9. Out of scope for v0.1

Tours, progress, specs, views, PR integration, notes/labels, non-JS adapters, hosted anything, dark theme.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Cross-repo linking misses dynamic URLs | confidence levels, dashed unresolved hops, manual links |
| Adapter coverage across stacks | plug-in interface; graceful fallback to plain map |
| Large repos → big graph files, slow canvas | incremental index, per-repo loading, expand on demand, git-lfs tip |
| Upstream UA changes | vendored core with recorded upstream commit; pull fixes deliberately |
| Agent-written content quality | everything agent-written is editable and stored as reviewable JSON |
