# Changelog

## 0.2.0 — unreleased

Tours and progress (v0.2b):

- Guided tours: Tour mode in the dashboard walks one journey in four parts (Flow, Data journey, File notes,
  Check yourself), with each stop's code beside its explanation and ← / → between stops. Tours are committed
  in `.codeloom/tours/<journey id>.json`; a stop whose file changed is marked "may be out of date".
- Progress: seen → toured → understood per journey, kept in `~/.codeloom/progress/` (never committed).
  Only a passed `check-me` marks a journey understood; when its code changes it needs a re-walk of just the
  changed stops. New Progress screen, understood % on Home, a progress strip per journey and the level on the
  Journey screen; the Continue band resumes your next tour stop.
- MCP: `build_tour_context`, `save_tour`, `get_progress`, `record_check` tools and `write-tour`, `check-me`
  prompts.
- The dashboard's only writes: `POST /api/progress/seen` and `POST /api/progress/toured` (same token and
  127.0.0.1 rules). `GET /api/tours/:id` never sends the check's expected answers.
- `codeloom doctor` checks the progress and tour files.

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
