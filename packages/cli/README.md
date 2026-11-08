<!-- Generated from the repo's README.md by packages/cli/test/docs.test.ts. Do not edit by hand. -->

<div align="center">

# codeloom

**Map a codebase into user journeys: UI page → API route → code → database.<br>For you, and for your AI agent over MCP.**

[![npm version](https://img.shields.io/npm/v/codeloom.svg?logo=npm&color=cb3837)](https://www.npmjs.com/package/codeloom)
[![npm downloads](https://img.shields.io/npm/dm/codeloom.svg)](https://www.npmjs.com/package/codeloom)
[![CI](https://github.com/Shreyas1015/codeloom/actions/workflows/ci.yml/badge.svg)](https://github.com/Shreyas1015/codeloom/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/codeloom.svg)](https://github.com/Shreyas1015/codeloom/blob/main/LICENSE)
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

You need Node 20 or newer and git. Run these in a repo, or in a folder that holds several repos:

```sh
npx codeloom init         # find the repos, write codeloom.workspace.json, add codeloom to .mcp.json
npx codeloom index        # build the map into .codeloom/
npx codeloom dashboard    # open the map in your browser (127.0.0.1 only)
```

Then open Claude Code in the same folder and run `/mcp__codeloom__name-journeys`. Claude groups the request
chains into named journeys, and the dashboard updates by itself.

`init` also adds a git hook that re-indexes after each commit. Install codeloom globally
(`npm i -g codeloom`) so the hook keeps working after the npx cache is cleared.

## What you get

- **Journeys across repos.** Each hop (page → call → route → handler → table) comes from reading the code and
  is marked `exact`, `param` or `guess`. Nothing is made up: a hop codeloom cannot resolve is listed with the
  reason.
- **A dashboard.** Home lists every journey; a Journey shows it in UI / API / code / DB lanes; the Map shows a
  repo from folders down to functions. See [docs/dashboard.md](https://github.com/Shreyas1015/codeloom/blob/main/docs/dashboard.md).
- **Tours that stick.** Claude walks you through one journey (the flow, a sample request down to the SQL, the
  traps per file), then quizzes you. Progress goes seen → toured → understood, and asks for a re-walk when
  the code changes.
- **Specs per journey.** codeloom finds the docs and ticket keys that mention each journey; Claude confirms
  the real ones, so you can see which features have no spec.
- **Views on request.** Ask Claude for a page ("customer journeys with no spec") and it builds one from
  codeloom's widgets.
- **A CI check.** `codeloom check --fail-under 80` fails the build when too few UI journeys reach the database.

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
known limits are in [docs/how-it-works.md](https://github.com/Shreyas1015/codeloom/blob/main/docs/how-it-works.md#accuracy).

## Docs

- [Working with your agent](https://github.com/Shreyas1015/codeloom/blob/main/docs/guide.md): tours, progress, specs and views
- [Reference](https://github.com/Shreyas1015/codeloom/blob/main/docs/reference.md): commands, MCP tools and prompts, the workspace file, the trace check
- [How it works](https://github.com/Shreyas1015/codeloom/blob/main/docs/how-it-works.md): the linker, confidence levels, `graph.json`, accuracy and limits
- [Dashboard](https://github.com/Shreyas1015/codeloom/blob/main/docs/dashboard.md): every screen
- [Changelog](https://github.com/Shreyas1015/codeloom/blob/main/CHANGELOG.md)

## Contributing

Bug reports, framework requests and pull requests are welcome: see [CONTRIBUTING.md](https://github.com/Shreyas1015/codeloom/blob/main/CONTRIBUTING.md) and
the [code of conduct](https://github.com/Shreyas1015/codeloom/blob/main/CODE_OF_CONDUCT.md). Please report security problems privately, as described in
[SECURITY.md](https://github.com/Shreyas1015/codeloom/blob/main/SECURITY.md).

## Credits and licence

The file map, tree-sitter parsing and layer detection come from
[Understand Anything](https://github.com/Egonex-AI/Understand-Anything) (MIT), vendored in `packages/core`
([NOTICE](https://github.com/Shreyas1015/codeloom/blob/main/NOTICE)). codeloom is [MIT](https://github.com/Shreyas1015/codeloom/blob/main/LICENSE) licensed and follows [Semantic Versioning](https://semver.org).
