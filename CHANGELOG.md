# Changelog

## 0.1.0 (unreleased)

First release.

- `codeloom init`, `index`, `check`, `doctor`, `dashboard` and `serve` commands.
- Maps a repo, or a folder of repos, into request chains: UI page → API route → handler → database table
  or queue, with `exact` / `param` / `guess` confidence on every hop and unresolved hops listed with a reason.
- Supports Next.js and React Router pages; fetch, axios, ky, got, superagent and wrapper functions; Express,
  Fastify, NestJS, Next.js API routes and AdonisJS; Prisma, Drizzle, TypeORM, Knex, Lucid and raw SQL;
  RabbitMQ (amqplib).
- Manual links and repo hints (`role`, `apiBase`) in `codeloom.workspace.json`.
- `codeloom check --traces`: compare the map with traces from Grafana Tempo or an OTLP JSON file.
- MCP server with 15 tools and 2 prompts (`name-journeys`, `verify-journey`).
- Read-only local dashboard: Home, Journey and Map screens.
- Re-indexes after each commit through a git post-commit hook.
- No AI, no telemetry; the only network call is the opt-in Tempo trace check.
