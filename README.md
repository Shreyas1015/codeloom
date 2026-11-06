# codeloom

codeloom maps a codebase into **user journeys**: a UI page, the API route it calls, the code that route
runs, and the database tables or queues it touches. It works across separate frontend and backend repos.
The map is built without AI, stays on your machine, and is shared with Claude (or any MCP agent) so the
agent can name the journeys and explain them.

A journey looks like this:

```
web  /customers/new        (page)
 └ POST /api/customers     (api route, in the api repo)
   └ CustomersController.store → CustomerService.create
     └ customers, audit_logs   (db tables)
```

## Quick start

You need Node 20 or newer and git. Run these in a repo, or in a folder that holds several repos:

```sh
npx codeloom init         # find the repos, write codeloom.workspace.json, add codeloom to .mcp.json
npx codeloom index        # build the map into .codeloom/
npx codeloom dashboard    # open the map in your browser (127.0.0.1 only)
```

Then open Claude Code in the same folder and run the `name-journeys` prompt. Claude Code lists MCP
prompts as `/mcp__codeloom__name-journeys`. Claude groups the request chains into named journeys and saves
them; the dashboard updates by itself.

`init` also adds a post-commit git hook that re-indexes after each commit. The hook runs the codeloom
that ran `init`, by its full path. With `npx` that is a copy in the npx cache, which can be cleared; then
the hook falls back to `codeloom` on your `PATH`. To keep the hook working, install it globally:
`npm i -g codeloom`.

## How it works

1. **Adapters** read your JS/TS code with the TypeScript compiler (no AI) and find pages, HTTP calls,
   API routes, database calls and queue calls.
2. The **linker** joins them into **chains**: page → call → route → handler → functions → table or queue.
   It follows imports and calls, and matches each UI call to a route, also across repos.
3. Each hop gets a **confidence**:
   - `exact`: the code proves the link.
   - `param`: matched less directly: a fixed URL to a route parameter (`/customers/42` to `/customers/:id`),
     a call made through your own wrapper function, or a function passed as a JSX prop.
   - `guess`: a likely link (e.g. the only method in the repo with that name). Guesses are shown dashed and
     never counted as found.
4. Anything it cannot resolve is kept on the chain as **unresolved**, with a reason. `codeloom check`
   lists them.
5. **Journeys** are named groups of chains. Your agent writes them (through MCP); codeloom never invents names.

Everything is written to `.codeloom/` folders as JSON and committed with your code, except
`.codeloom/fingerprints.json` (a local cache, git-ignored by `init`). Re-running `codeloom index` with no code
change leaves every committed file unchanged.

The file map (folders, files, functions) uses the tree-sitter parsers from
[Understand Anything](https://github.com/Egonex-AI/Understand-Anything), so it covers more languages than JS/TS.
Journeys need JS/TS.

What `graph.json` holds (v0.2a):

- **Method nodes.** Each class method and object-literal method is a `function` node (`function:<file>:<Class.method>`,
  tag `method`). For a TypeScript overload, the node covers the implementation, not the signatures.
- **Checked `calls` edges.** For JS/TS files, codeloom's own call resolver decides every `calls` edge. Each one has
  a confidence in `description`: `exact` (weight 1) or `param` (weight 0.6; likely: passed or wired, not a direct
  call). A tree-sitter call edge the resolver does not confirm is dropped. In other languages tree-sitter's edges
  stay, marked `unverified` (weight 0.3), and the dashboard and MCP tools show them dashed and labelled.
- **Nameless classes** (`const Customer = class { … }`) get the id `<anonymous@L12>` from the line they start on.
  The id changes when lines above the class are added or removed.
- **Skipped files.** Bundled or minified JavaScript (`*.min.js`, `*.bundle.js`, `*-bundle.js` — `.js`, `.cjs`,
  `.mjs` only — or bundler output) stays on the map as a file but is not analysed: no methods, calls or
  endpoints. `.claude/` and `.cursor/` folders are ignored by default.
- **Wrapped default exports.** `export default connect(…)(Customer)` stands for `Customer`. Known wrappers
  (`connect(…)(X)`, `memo`, `React.memo`, `forwardRef`, `withRouter`, `observer`, `inject(…)(X)`, `compose(…)(X)`,
  and any `with…` such as `withAuth`) keep the link `exact`. Any other wrapper (`makeHandler(fn)`) gives `param`.
  A wrapped value that is not a local function or class is not followed.

`graph.json` grows with these: up to 1.8× on the test apps (see "graph.json size" in
[fixtures/evals](fixtures/evals/README.md)).

### What it finds

| Part | Supported |
|---|---|
| UI pages | Next.js (`app/` and `pages/`), React Router |
| HTTP calls | `fetch` (and `$fetch`, `ofetch`, `useFetch`), axios, ky, got, superagent, redaxios, wretch, clients made with `.create(...)`, and your own wrapper functions around them |
| API routes | Express, Fastify, NestJS, Next.js API routes (`app/**/route.ts` and `pages/api`), AdonisJS |
| Database | Prisma, Drizzle, TypeORM, Knex, AdonisJS Lucid, Mongoose (collections), raw SQL (pg, mysql2, better-sqlite3, postgres, sqlite3), `.sql` files, `schema.prisma` |
| Queues | RabbitMQ through amqplib (`sendToQueue`, `publish`, `consume`, `bindQueue`) |

## Commands

| Command | What it does |
|---|---|
| `codeloom init [dir]` | Set up a repo or a folder of repos: workspace file, `.codeloom/config.json` per repo, post-commit hook, `.gitignore` line, `.mcp.json` entry. |
| `codeloom index` | Index every repo in the workspace. Only changed files are parsed again. `--quiet` prints nothing on success. |
| `codeloom check` | Report how complete the map is: chains that run UI → API → DB, chains that run API → DB only (no UI caller), chains missing the DB step or broken at UI → API, how many routes have a UI caller, unresolved calls, guessed links. |
| `codeloom check --json` | The same report as JSON. |
| `codeloom check --fail-under 80` | Exit 1 when less than 80% of the chains that start in the UI are complete. Useful in CI. |
| `codeloom check --traces` | Also compare the map with real traffic (see [Trace check](#trace-check)). |
| `codeloom doctor` | Check the data files, hooks, `.gitignore` line and MCP entry. `--fix` repairs what is safe to repair. `--json` prints JSON. |
| `codeloom dashboard` | Serve the dashboard on 127.0.0.1 and open it. `--port <port>` picks the port; `--no-open` only prints the URL. |
| `codeloom serve` | Run the MCP server on stdio. `init` puts this in `.mcp.json` as `npx -y codeloom serve`. |

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

The dashboard has three screens: Home (journey list), Journey (UI / API / code / DB lanes) and Map (one repo,
folders to functions). See [docs/dashboard.md](docs/dashboard.md).

## MCP tools and prompts

`codeloom serve` gives your agent these tools. They read the map fresh on every call. Only `save_journeys`,
`save_summary` and `save_tour` write to the workspace, and `reindex` runs the indexer. `record_check` writes
your personal progress, kept in `~/.codeloom` and never committed.

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
| `get_progress` | Your progress per journey (seen, toured, understood), stops to re-walk, last check, totals per repo and area, and what is left. |
| `record_check` | Record a `check-me` result. A pass is the only way to mark a journey understood. |

| Prompt | What it asks the agent to do |
|---|---|
| `name-journeys` | Group the unnamed chains into short, plain-language journeys and save them. |
| `verify-journey` | Check one journey hop by hop against the code and report what agrees or looks doubtful. |
| `write-tour` | Write a plain-language tour of one journey (flow, data journey, file notes, 3 check questions) and save it. |
| `check-me` | Ask you 3 questions about one journey, one at a time, judge the answers against the code, and record the result. |

## Workspace file

`codeloom init` writes `codeloom.workspace.json`. You can edit it:

```json
{
  "version": 1,
  "name": "demo-shop",
  "repos": [
    { "id": "web", "path": "web", "role": "ui" },
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
- `links`: hops you add by hand when codeloom cannot see them. Each end is one of:
  - `<repo>:<file>#<function>`
  - `route:<repo>:<METHOD> <path>`
  - `queue:<repo>:<queue>`

  A manual link is `exact`. `codeloom check` lists links that could not be resolved or match no chain.
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

## Accuracy

codeloom's linker is scored in CI against hand-written answer keys for three open-source apps
([fixtures/evals](fixtures/evals/README.md)). CI fails below 95% precision or 80% recall for any app and hop
type. Precision counts `exact` and `param` hops only.

| App | UI → API | Route → handler | Handler → DB |
|---|---|---|---|
| prisma-rest-nextjs | 4/4 | 5/5 | 5/5 |
| realworld | 22/22 | 21/21 | 32/32 |
| realworld-nest | no UI | 4/4 | 3/3 |

Precision and recall are 100% in every cell (scores from 2026-11-01). These are small apps; expect lower
numbers on large ones.

Known limits:

- Class components and Redux are followed at `param`: lifecycle methods and `render`, `this.handleX` handlers,
  `this.props.onX()` when the JSX passes a function, `connect(mapState, mapDispatch)`, `dispatch(thunk())`,
  `createAsyncThunk` and RTK Query `createApi` endpoints (with `fetchBaseQuery`) and their generated hooks.
  RTK Query `injectEndpoints` and custom `baseQuery` functions are not read. In realworld, 21 of the 22 UI
  calls are now reached from a page; the last one (deleting a comment) is more than 6 calls below its page.
- A method call on an object whose class codeloom cannot see (for example, one passed in as a parameter) is
  linked only when exactly one method in the repo has that name, and then only as a `guess`. Common
  built-in and ORM method names (`map`, `then`, `create`, `save`, …) are never guessed.
- Tested on a real two-repo app (a React UI and an AdonisJS API, about 3,000 files): about 120 UI → API links
  were found and all checked links were right, but some UI calls still have no page (v0.2a now follows a
  handler passed as a plain function argument). Calls to a backend that is not in the workspace show as calls
  to other services only when your repos declare an `apiBase` (or the service is listed under `external`);
  otherwise they still show as UI calls that match no route.
- A component reused for "create" and "edit" can link its edit path to the create call (marked `param`).
- When two routes match a call equally well, the one with a fixed segment (not a parameter) at the first
  place where they differ wins, at `param` (`GET /invoices/summary` picks `/invoices/:id` over
  `/:kind/summary`). A real tie (for example `/items/:id` and `/items/:slug`) stays a `guess`.

## Not in v0.1

- Journeys only for JavaScript and TypeScript code.
- Queues: RabbitMQ (amqplib) only.
- The dashboard is read-only and shows Home, Journey and Map. Guided tours, "understood" progress, spec
  badges and custom views come later.

## Credits

The file map, tree-sitter parsing and layer detection come from
[Understand Anything](https://github.com/Egonex-AI/Understand-Anything) (MIT), vendored in `packages/core`.
Its licence notice is in [NOTICE](NOTICE).

## Licence

[MIT](LICENSE)
