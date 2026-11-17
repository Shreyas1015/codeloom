<div align="center">

# codeloom

**Map a codebase into user journeys: UI page → API route → code → database.<br>For you, and for your AI agent over MCP.**

[![npm version](https://img.shields.io/npm/v/codeloom.svg?logo=npm&color=cb3837)](https://www.npmjs.com/package/codeloom)
[![npm downloads](https://img.shields.io/npm/dm/codeloom.svg)](https://www.npmjs.com/package/codeloom)
[![CI](https://github.com/Shreyas1015/codeloom/actions/workflows/ci.yml/badge.svg)](https://github.com/Shreyas1015/codeloom/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/codeloom.svg)](LICENSE)
[![node](https://img.shields.io/node/v/codeloom.svg?logo=node.js)](https://nodejs.org)

</div>

codeloom maps your code into **user journeys**: the page a user opens, the API route it calls, the code that
route runs, and the tables or queues it touches, even when the frontend and backend live in separate repos.
The map is built without AI, stays on your machine, and is shared with your agent (Claude Code, or any MCP
client) so it can name each journey and explain it to you.

```
web  /customers/new        (page)
 └ POST /api/customers     (api route, in the api repo)
   └ CustomersController.store → CustomerService.create
     └ customers, audit_logs   (db tables)
```

## Quick start

You need Node 20 or newer and git. Run this in a repo, or in a folder that holds several repos:

```sh
npx codeloom init
```

`init` is a guided, one-step setup: it finds the repos (pre-unselecting duplicate checkouts of the same
remote, so a folder with several copies of the same repo only maps one), asks whether to commit codeloom's
files with your code or keep them local, builds the map, connects Claude Code when it is on PATH, and
offers to open the dashboard. `--yes` takes every default instead of asking (for CI or scripts); re-running
`init` only asks about whatever is still missing.

When Claude Code is connected, `init` can also ask it to name your journeys right there — or run
`/mcp__codeloom__name-journeys` yourself any time. Claude groups the request chains into named journeys,
and the dashboard updates by itself. codeloom never starts Claude without asking first.

`init` also adds a git hook that re-indexes after each commit (when you chose to commit its files). Install
codeloom globally (`npm i -g codeloom`) so the hook keeps working after the npx cache is cleared.

## What you get

- **Journeys across repos.** Each hop (page → call → route → handler → table) comes from reading the code and
  is marked `exact`, `param` or `guess`. Nothing is made up: a hop codeloom cannot resolve is listed with the
  reason.
- **A dashboard.** Home lists every journey; a Journey shows it in UI / API / code / DB lanes; the Map shows a
  repo from folders down to functions. See [docs/dashboard.md](docs/dashboard.md).
- **Tours that stick.** Claude walks you through one journey (the flow, a sample request down to the SQL, the
  traps per file), then quizzes you. Progress goes seen → toured → understood, and asks for a re-walk when
  the code changes.
- **Specs per journey.** codeloom finds the docs and ticket keys that mention each journey; Claude confirms
  the real ones, so you can see which features have no spec.
- **Views on request.** Ask Claude for a page ("customer journeys with no spec") and it builds one from
  codeloom's widgets.
- **A CI check.** `codeloom check --fail-under 80` fails the build when too few UI journeys reach the database.
- **PR drafts Claude can check.** `codeloom review --base main` writes a plain draft of a pull request from
  the map alone (no AI): where it matters, what it writes, what to do before deploying, the functions to check
  and a small diagram. `codeloom review --check` lets Claude check it and say what the PR does — codeloom
  asks before starting Claude.
- **PR review maps.** `codeloom init --github` adds two workflows that post a summary and a Mermaid diagram of
  what each pull request touches, with a link to a hosted, read-only dashboard snapshot on GitHub Pages. See
  [docs/pr-review-maps.md](docs/pr-review-maps.md).

## Supported

| Part | Supported |
|---|---|
| UI pages | Next.js (`app/` and `pages/`), React Router |
| HTTP calls | fetch, axios, ky, got, superagent, redaxios, wretch, and your own wrappers around them |
| API routes | Express, Fastify, NestJS, Next.js API routes, AdonisJS |
| Database | Prisma, Drizzle, TypeORM, Knex, AdonisJS Lucid, Mongoose, raw SQL |
| Queues | RabbitMQ (amqplib) |

Journeys need JavaScript or TypeScript. The file map covers more languages, through tree-sitter.

## Private by design

- No AI and no telemetry. The only network call is the trace check, and only when you ask for it.
- The map is plain JSON in `.codeloom/`, committed with your code. Your own progress stays in `~/.codeloom`.
- The dashboard listens on 127.0.0.1 only.

## Accuracy

CI scores the linker against hand-labelled answers for three open-source apps, and fails below 95% precision
or 80% recall. Today every score is 100%. These are small apps, so expect lower numbers on large ones; the
known limits are in [docs/how-it-works.md](docs/how-it-works.md#accuracy).

## Docs

- [Working with your agent](docs/guide.md): tours, progress, specs and views
- [Reference](docs/reference.md): commands, MCP tools and prompts, the workspace file, the trace check
- [How it works](docs/how-it-works.md): the linker, confidence levels, `graph.json`, accuracy and limits
- [Dashboard](docs/dashboard.md): every screen
- [Changelog](CHANGELOG.md)

## Contributing

Bug reports, framework requests and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and
the [code of conduct](CODE_OF_CONDUCT.md). Please report security problems privately, as described in
[SECURITY.md](SECURITY.md).

## Credits and licence

The file map, tree-sitter parsing and layer detection come from
[Understand Anything](https://github.com/Egonex-AI/Understand-Anything) (MIT), vendored in `packages/core`
([NOTICE](NOTICE)). codeloom is [MIT](LICENSE) licensed and follows [Semantic Versioning](https://semver.org).
