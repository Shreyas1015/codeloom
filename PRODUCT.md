# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + Vite + shadcn/ui + Tailwind + TanStack Query/Router + React Flow for the dashboard (chosen over Next.js static export on 2026-10-30: the dashboard ships as static files inside the npm package; fork-friendly with Understand Anything's React dashboard; React Flow for boxes, connectors, expand/collapse). shadcn is themed to the Gallery Guide world, never left at its default look. No Python/FastAPI in the package. Built to static files and served locally by `codeloom dashboard`. The package itself is a Node/TypeScript CLI + MCP server published to npm as `codeloom`.

## Users

Primary: the author (a TypeScript developer working on AdonisJS backends, Next.js frontends, Postgres, RabbitMQ; repos on Bitbucket), sitting down for 20–60 minute deep-dive sessions to really learn a codebase: a new repo, a multi-repo product (Shopfront: core-service + several UIs), or a feature someone else built. Desktop browser on localhost, next to Claude Code in a terminal.

Later: open-source developers doing the same job on their own codebases.

## Product Purpose

codeloom maps a codebase (or a workspace of repos) without AI, keeps the map current on every commit, and gives it to Claude or any agent through MCP. The dashboard turns that map into user journeys a person can learn one by one, and tracks how much of the codebase they truly understand. Success: the user can say "I understand 80% of this product" and be right, because they walked the journeys and passed the checks.

## Positioning

The unit of understanding is the **user journey** (UI page → API route → service → DB table), detected across separate frontend and backend repos, not a folder tree. Each journey has a guided tour with a **Data Journey**: a sample request followed file by file down to the actual SQL. Neither CodeSee nor Understand Anything does this. Analysis is local and AI-free; the user's own agent supplies summaries and explanations.

## Operating Context

- Run locally: `npx codeloom init` in a parent folder of repos → workspace file; `codeloom index` (tree-sitter, git-hook driven); `codeloom dashboard` (localhost); `codeloom serve` (MCP).
- Journeys: auto-detected route chains as skeleton; Claude groups and names them; user can edit/merge.
- Multi-repo: workspace file listing local clones; each repo has its own graph; codeloom joins them.
- Specs: markdown in repos (docs/, specs/, README, ADRs) matched to journeys, plus ticket keys from commits/branches. States: spec found / ticket only / none.
- Progress: three levels per journey — seen → toured → understood (passed its 3 "Check yourself" questions, judged by Claude). Repo/workspace % = journeys understood / total.
- Customisation: dashboard screens are built from ready-made widgets; Claude edits `.codeloom/views/*.json` via MCP. Custom code panels later. The author's default layout ships as the default.

## Capabilities and Constraints

- Screens: Home (counts + journey list), Journey (FE/BE/DB lanes), Tour (phases: Flow → Data Journey → File notes → Check yourself), Map (knowledge graph per repo or whole workspace), Progress, Views.
- No API keys inside the package; no code leaves the machine.
- CodeSee features are re-implemented, never copied. Understand Anything is MIT; forked parts keep its notice.
- Undecided: hosted sharing / live collaboration (later).

## Brand Commitments

Name: **codeloom**. CodeSee is a feature model only, not a visual reference: codeloom has its own identity. The author asked for it to be fun to understand code, and user-friendly.

## Evidence on Hand

- Project brief: `docs/BRIEF.md`.
- Sample feature tour: `a sample feature-tour file` (real content for journey/tour mockups).
- No users, testimonials, benchmarks, or adoption numbers exist; never fabricate them.

## Product Principles

1. Journeys first: every screen answers "which user journey is this, and do I understand it?"
2. Honest progress: "understood" is earned by a check, never by opening a page.
3. Follow the data: show real files, lines and SQL, not abstractions.
4. Local and cheap: structure without AI; the agent adds words on demand.
5. Plain language: short, scannable, real paths and line numbers.
