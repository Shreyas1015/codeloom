# codeloom reference

Every command, MCP tool and prompt, and the workspace file. For a first look, start with the [README](../README.md).

## Commands

| Command | What it does |
|---|---|
| `codeloom init [dir]` | Guided one-step setup: pick the repos to map (duplicate checkouts of the same remote are pre-unselected, keeping the one on its default branch), commit codeloom's files with your code or keep them local (`.git/info/exclude`), index, connect Claude Code when it is on PATH (pinned to this codeloom version in `.mcp.json`), and open the dashboard. `--yes` takes every default instead of asking (also the default when stdin or stdout is not a terminal). Re-running `init` on an already set-up workspace only asks about what is still missing. `--github` instead runs the plain, non-interactive setup and also writes the two [PR review map](pr-review-maps.md) workflows to `.github/workflows/`, pinned to this codeloom version; an existing, customised copy of either file is kept as is. |
| `codeloom index` | Index every repo in the workspace. Only changed files are parsed again. `--quiet` prints nothing on success. |
| `codeloom check` | Report how complete the map is: chains that run UI → API → DB, chains that run API → DB only (no UI caller), chains missing the DB step or broken at UI → API, how many routes have a UI caller, unresolved calls, guessed links. |
| `codeloom check --json` | The same report as JSON. |
| `codeloom check --fail-under 80` | Exit 1 when less than 80% of the chains that start in the UI are complete. Useful in CI. |
| `codeloom check --traces` | Also compare the map with real traffic (see [Trace check](#trace-check)). |
| `codeloom review --base <ref>` | The PR block for a pull request, for `merge-base(<ref>, HEAD)..HEAD`, built from the map alone (no AI). It opens with _Draft by codeloom — not checked._ and a **What it does** line left for Claude to fill in, then: **Where it matters** (the pages, routes and queue consumers that reach the changed code, named by journey when one is named; at most 5), **What it writes** (the tables and queues the changed code inserts into, updates, deletes from or publishes to, on its own chains after the change — then "Reads only:" for tables it only reads), **⚠ Before deploying** (changed migration or schema files, `.env*` / `env.ts` files and new `.env.example` keys, a new `process.env.X` read, Docker and CI files; left out when there are none), **Code to check** (the changed functions with +/− line counts — changed ones on a chain first, then other changed, new and deleted ones; at most 8; functions in test and docs files are left out, and new or deleted files add at most 8 functions that are on no chain, with a note saying how many more), a small diagram of only the changed path (entry point → route → handler → changed function → what it writes; at most 8 boxes, then "+N more"), and one "Also changed: N files" line for files on no chain. Paste it into a PR description. `--repo <id>`: in a folder of separate repos, the repo the pull request is in — only that repo's history is diffed (merge-base inside it) and every other repo is read as it is checked out now; optional when the workspace root is itself the one git repo (every repo is diffed together), when there is only one repo, or when you run it from inside a repo's folder. `--format full` prints the 0.4 block instead (a summary line, a Mermaid diagram of every affected chain, a journey/spec table and the changed files on no mapped chain — what a hosted PR snapshot posts); `--format json` prints the underlying `Review` data. `--link <url>` adds an "Open the full review map" line. Once Claude has checked the PR, the block for that same HEAD shows _Checked by Claude <date>._ with Claude's **What it does** and **Where it matters**, and Claude's notes beside the detected writes, deploy risks and changed functions — those always stay; Claude can add to them, never remove one (a review saved for an older HEAD is ignored; an unreadable one is skipped with a warning). `--packet` prints the check packet Claude reads — the draft as data, only the changed hunks of each changed function (at most 60 lines each, 400 in all), the commit messages (at most 40 lines) and the names it may use — as JSON of at most 24,000 characters, listing in `cut` whatever was left out. `--check` lets Claude check the draft now: it runs your Claude Code (`claude -p`, in the workspace root) with the `check-pr` prompt and the packet inlined, isolated: no built-in tools (no file reads, no shell), only this codeloom's own MCP server, only your user settings (never the checkout's), and only `save_pr_review` allowed; it still reads the checkout's `CLAUDE.md`, and the only thing it can do is call `save_pr_review`; then prints the checked block; without `claude` on PATH it prints the prompt for you to run instead. On a terminal, `codeloom review` asks "Let Claude check this PR now? (uses your Claude Code)" (default no); it never starts Claude without `--check` or your yes. |
| `codeloom snapshot --base <ref> --out <dir>` | Writes `<dir>/data/*.json`: the dashboard's full API answers at `merge-base(<ref>, HEAD)..HEAD`, for a hosted read-only PR snapshot. `--out` must be empty or not exist — refused otherwise (exit 2), never touching whatever is already there. `--max-size <size>` caps the total (default `25MB`; also takes a bare byte count). `--data-only` writes only `data/`, with no dashboard assets or `review.md` — the untrusted CI build step; the trusted publish step is `codeloom snapshot-site`. |
| `codeloom snapshot-site --out <dir>` | The trusted publish half of a hosted PR snapshot: with `--data <dir> --head <sha>`, validates a build artifact's `data/*.json` (never trusting anything else in it — a wrong `head`, a symlink, a non-JSON file, a file over 5 MB or a total over `--max-size` is refused) and writes the site to `<dir>` (this codeloom version's own dashboard assets, never the artifact's), `<dir>/review.md`, and, with `--body <file>`, the PR block spliced into that file (minus one trailing newline, the one `gh pr view --json body -q .body` adds) as `<dir>/body.md` (or `<dir>/comment.md` over GitHub's 65,536-character body limit). `--out` must be empty or not exist, same as `codeloom snapshot` — refused (exit 2) otherwise, before anything is touched. `--pr <n>` and `--repo <owner/name>` are filled into the manifest. With `--failed <run-url>` instead of `--data`/`--head`, the build itself failed: writes only the error block linking to that run, plus `--previous <manifest>` (the last good snapshot's own `data/manifest.json`) for a "last good map" link. An artifact that fails validation still gets a `review.md` saying so (exit 1), and `body.md`/`comment.md` too when `--body` was given — but nothing else (no `data/`, no dashboard assets) ever reaches `<dir>`. `--pages-disabled` (valid with `--data` or `--failed`) means GitHub Pages isn't enabled for this repo: the block gets a one-line note on enabling it instead of any "Open the full review map" / last-good-map link. |
| `codeloom doctor` | Check the data files, hooks, `.gitignore` line and MCP entry. `--fix` repairs what is safe to repair. `--json` prints JSON. |
| `codeloom dashboard` | Serve the dashboard on 127.0.0.1 and open it. `--port <port>` picks the port; `--no-open` only prints the URL. |
| `codeloom serve` | Run the MCP server on stdio. `init` puts this in `.mcp.json` as `npx -y codeloom serve`. |
| `codeloom views list` | List the dashboard views your agent saved, with their links. A broken view shows why. |
| `codeloom views reset <id>` | Delete a view. `codeloom views reset home` brings back the built-in Home. Views are only ever written by your agent (`save_view`). |

`check` starts with a summary like this:

```text
7 journeys: 3 complete UI → API → DB, 2 API → DB only (no UI caller), 2 missing the DB step
routes with a UI caller: 3/5
complete: 100% of journeys that start in the UI (3/3)
```

A chain is complete only when it starts at a page or UI call and reaches a database table or queue. A
route or queue consumer that reaches the database but that no UI code calls counts as API → DB only, and
`--fail-under` leaves it out of the ratio. With no chain that starts in the UI, the ratio is 0%, so
`--fail-under` fails: nothing is proven end to end.

Exit codes: `0` ok, `1` `--fail-under` not met (or `doctor` found errors), `2` a data or usage error
(missing or broken `.codeloom` files, bad flag value).

The dashboard has five screens: Home (journey list), Journey (UI / API / code / DB lanes, plus its specs), Tour
(walk one journey stop by stop), Map (one repo, folders to functions) and Progress (how much you understand),
plus any views your agent saved. See
[docs/dashboard.md](dashboard.md).

## MCP tools and prompts

`codeloom serve` gives your agent these tools. They read the map fresh on every call. Only `save_journeys`,
`save_summary`, `save_tour`, `save_spec_links`, `save_view` and `delete_view` write to the workspace, and
`reindex` runs the indexer. `record_check` writes your personal progress, kept in `~/.codeloom` and never
committed. `pr_check_packet` and `save_pr_review` (and the `check-pr` prompt) keep their files in
`.codeloom/reviews/`, which is local only and never committed.

| Tool | What it returns |
|---|---|
| `workspace_overview` | Start here: the repos, their size, and counts of pages, routes, tables, queues, chains and journeys. |
| `index_status` | Per repo: the commit it was indexed at and whether the index is stale. |
| `reindex` | Runs the indexer and linker again. |
| `get_layers` | The architectural layers found in a repo, with node counts. |
| `list_chains` | Request chains, filtered by repo, completeness, confidence, or unnamed. Paged. Compact rows (stops per lane, tables); `detail: true` adds the stops. |
| `get_journey` | One journey (`j_…`) or chain (`ch_…`) laid out by lane, with what could not be resolved. |
| `trace_route` | The chains that pass through a route, page, table or queue. |
| `save_journeys` | Create, update, merge, split or delete journeys in `.codeloom/journeys.json`. |
| `search` | Fuzzy search over files, functions, routes, pages, tables, queues, journeys and chains. |
| `get_node` | One file, function or class: its edges and the chains and journeys it is part of. |
| `get_neighbors` | The nodes around one node, 1 to 3 hops away. |
| `explain_context` | One node's source, summary, neighbours, chains and journeys, in one call. |
| `save_summary` | Save a short summary of a node to `.codeloom/summaries.json`. |
| `check_chains` | The `codeloom check` summary, totals per item kind and up to 20 items per kind (optionally with the trace check). `kinds`, `limit` and `offset` page through the items. |
| `impact_of_diff` | The files, nodes, chains and journeys a code change touches. |
| `build_tour_context` | Everything needed to write a journey's tour: each stop's code, types, request/response shapes, DB detail, neighbours and file hash. |
| `save_tour` | Save a journey's tour to `.codeloom/tours/<journey>.json`. Stops must be the journey's own; codeloom computes the hashes. |
| `get_progress` | Your progress per journey (seen, toured, understood), stops to re-walk, last check, totals per repo and area (a journey that needs a re-walk counts as toured), and what is left. |
| `record_check` | Record a `check-me` result. A pass is the only way to mark a journey understood. |
| `match_specs` | The docs and tickets codeloom found for one journey (docs that mention its routes, pages, tables, queues or code, with the lines around each hit; ticket keys from the commits that touched its files). Only hints. |
| `save_spec_links` | Save the docs and tickets that really describe a journey to `.codeloom/specs.json`, each with a one-line reason. `[]` records "checked, no spec". |
| `list_specs` | Spec coverage per journey (linked, candidates waiting, none; checked or not) with totals per repo and area. |
| `save_view` | Save a dashboard view built from a fixed set of widgets to `.codeloom/views/<id>.json`. The id `home` replaces Home. |
| `list_views` | The saved views with their dashboard links, or why one cannot be read. |
| `delete_view` | Delete a saved view (not `home`: use `codeloom views reset home`). |
| `pr_check_packet` | The check packet for a pull request (`base`, and `repo` in a folder of repos): codeloom's draft as data, the changed hunks, the commit messages and every name `save_pr_review` accepts, in at most 24,000 characters. |
| `save_pr_review` | Save Claude's checked review of a pull request to `.codeloom/reviews/<head>.json`. `head` must still be HEAD, and every function, route, page, table, queue or file it names (and any `Name.member` or snake_case name in its text) must be in the packet, or nothing is saved and the bad names are listed. Detected writes, deploy risks and changed functions always stay: Claude can add a note beside one or add an item, never remove one. |

| Prompt | What it asks the agent to do |
|---|---|
| `name-journeys` | Group the unnamed chains into short, plain-language journeys and save them. |
| `verify-journey` | Check one journey hop by hop against the code and report what agrees or looks doubtful. |
| `write-tour` | Write a plain-language tour of one journey (flow, data journey, file notes, 3 check questions) and save it. |
| `check-me` | Ask you 3 questions about one journey, one at a time, judge the answers against the code, and record the result. |
| `match-specs` | For one journey (or every one not checked yet): read the candidate docs and tickets and the code, and save only the ones that really describe it. |
| `make-view` | Turn a plain request ("customer journeys with no spec") into a dashboard view, save it and give you its `/views/<id>` link. |
| `check-pr` | Check codeloom's draft review of a pull request (`base`, and `repo` in a folder of repos) against the packet inlined in the prompt, correct it, write what it does in 1–2 plain sentences, and save it with `save_pr_review`. |

## Workspace file

`codeloom init` writes `codeloom.workspace.json`. You can edit it:

```json
{
  "version": 1,
  "name": "demo-shop",
  "repos": [
    { "id": "web", "path": "web", "role": "ui", "proxies": [{ "from": "/api/core", "to": "api" }] },
    { "id": "api", "path": "api", "role": "api", "apiBase": ["NEXT_PUBLIC_API_URL", "api.demo-shop.test"] },
    { "id": "billing", "path": "billing", "role": "worker" }
  ],
  "links": [
    { "from": "web:lib/legacy.ts#saveLegacy", "to": "route:api:POST /api/customers" }
  ],
  "external": [
    { "name": "Payments", "apiBase": ["PAYMENTS_URL", "pay.example.com"] }
  ]
}
```

- `role` (optional): `ui`, `api`, `worker` or `lib`. A hint for which repo a UI call goes to.
- `apiBase` (optional): env var names or hosts whose calls go to this repo.
- `proxies` (optional): backend-for-frontend proxy rules. A UI call whose URL starts with `from` is also
  matched, with that prefix stripped, against `to`'s routes — so a call to `/api/core/customers/42`
  through the `web` repo's own `/api/core/*` proxy route above also matches `api`'s `GET /customers/:id`
  (the usual exact/param confidence). The call's own route (the proxy route itself) keeps its chain; a
  proxy match adds a further one, continuing into `to`'s handler and tables. Set `"stripPrefix": false` to
  match the call's full URL instead of the stripped one. `to` must be another repo id in this workspace.

  A generated client (openapi-fetch and similar, called as `client.GET(...)`/`client.POST(...)`,
  uppercase, with OpenAPI-style `{param}` path placeholders) created behind a local factory still works:
  `function backendClient(backend) { return createClient({ baseUrl: \`/api/${backend}\` }); }` then
  `const coreClient = backendClient("core")` gets a real base (`/api/core`), so `coreClient.GET("/customers/{id}")`
  matches the `from: "/api/core"` rule above like a plain `fetch("/api/core/customers/{id}")` would. This only covers one level of
  indirection (a single literal argument flowing straight into the template); anything less direct, or a
  call that isn't same-origin to begin with (an absolute URL, a third-party client base), is never guessed
  at and never gets a proxy match.
- `links`: hops you add by hand when codeloom cannot see them. Each end is one of:
  - `<repo>:<file>#<function>`
  - `route:<repo>:<METHOD> <path>`
  - `queue:<repo>:<queue>`

  A manual link is `exact`. `codeloom check` lists links that could not be resolved or match no chain.
- `specs` (optional): how codeloom looks for spec candidates. `docs`: extra doc globs; `ignoreDocs`: globs
  to skip; `ticketPattern`: the ticket key regex (default: an uppercase key like `SHOP-12` that is not part of a
  longer token such as `ORD-MH-26-001`; at most 100 characters, with no nested quantifiers like `(a+)+` and
  no backreferences); `ignorePrefixes`: key prefixes that are not tickets (default `AC`, `ADR`, `CVE`, `ID`,
  `ISO`, `QA`, `RFC`, `SHA`, `TC`, `UTF`). For example
  `"specs": { "ticketPattern": "\\bSHOP-\\d+\\b", "ignoreDocs": ["docs/archive/**"] }`.
- `external` (optional): other services the UI calls that are not repos in this workspace. A call whose
  env var or host is in an entry's `apiBase` is a call to that `name`, never matched to a route.

Calls to other services: a UI call that goes to a host or env var that no repo's `apiBase` names is a call
to another service, not a broken link. `codeloom check` lists these under "Calls to other services" (by
`external` name, else by env var or host) and never counts them as broken; the dashboard shows
"calls <name>" on the journeys whose pages make them. An env var call is only treated this way when it
matches no route and some repo has an `apiBase`, so give your own backends an `apiBase` to tell them apart.

## Trace check

`codeloom check --traces` compares the map with runtime traces: routes confirmed by traffic, links seen in
traffic but missing from the map, and routes never hit. It never changes the exit code. Add a `traces`
entry to `codeloom.workspace.json`.

From Grafana Tempo:

```json
"traces": {
  "kind": "tempo",
  "url": "http://localhost:3200",
  "headersEnv": "TEMPO_HEADERS",
  "services": { "demo-shop-api": "api" },
  "lookback": "1h"
}
```

From an OTLP JSON file (`.json`, or `.jsonl` / `.ndjson` with one export per line), relative to the workspace root:

```json
"traces": { "kind": "otlp-file", "path": "traces/export.json", "services": { "demo-shop-api": "api" } }
```

- `services` maps a trace's `service.name` to a repo id. Without it, the service name is used as the repo id.
- `headersEnv` names an environment variable holding request headers, OTEL style:
  `TEMPO_HEADERS="Authorization=Bearer%20abc,X-Scope-OrgID=demo"`. Header values are never printed.
- `lookback` is how far back to search: a number followed by `m`, `h` or `d`. Default `1h`.
- Tempo requests time out after 10 seconds. If Tempo cannot be reached, the trace check is skipped.

This is the only network call codeloom makes, and only when you ask for it.
