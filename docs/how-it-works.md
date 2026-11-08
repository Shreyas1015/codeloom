# How codeloom works

How the map is built, what each confidence means, what `graph.json` holds, and how accurate it is.

## From code to chains

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
[fixtures/evals](../fixtures/evals/README.md)).

### What it finds

| Part | Supported |
|---|---|
| UI pages | Next.js (`app/` and `pages/`), React Router |
| HTTP calls | `fetch` (and `$fetch`, `ofetch`, `useFetch`), axios, ky, got, superagent, redaxios, wretch, clients made with `.create(...)`, and your own wrapper functions around them |
| API routes | Express, Fastify, NestJS, Next.js API routes (`app/**/route.ts` and `pages/api`), AdonisJS |
| Database | Prisma, Drizzle, TypeORM, Knex, AdonisJS Lucid, Mongoose (collections), raw SQL (pg, mysql2, better-sqlite3, postgres, sqlite3), `.sql` files, `schema.prisma` |
| Queues | RabbitMQ through amqplib (`sendToQueue`, `publish`, `consume`, `bindQueue`) |

## Accuracy

codeloom's linker is scored in CI against hand-written answer keys for three open-source apps
([fixtures/evals](../fixtures/evals/README.md)). CI fails below 95% precision or 80% recall for any app and hop
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

## Not yet

- Journeys only for JavaScript and TypeScript code.
- Queues: RabbitMQ (amqplib) only.
- The dashboard writes only your own progress (seen, toured); journeys, tours, spec links and views come
  from your agent. Team-shared progress comes later.
- Ticket text is never fetched; views use only the fixed widget set (no custom panels or HTML).
