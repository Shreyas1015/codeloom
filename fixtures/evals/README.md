# Eval apps

Trimmed, licence-compatible copies of real open-source apps, used only in CI (`test/evals.test.ts`) to score
codeloom's linker against hand-written answer keys — the same per-hop-type precision/recall check as
`fixtures/demo-shop/expected-journeys.json`, but on code codeloom's authors didn't write themselves. Each
`<app>/` folder holds:

- `SOURCE.md` — upstream URL(s), the exact commit SHA vendored, and licence
- `LICENSE` — the upstream project's licence file, unmodified
- `codeloom.workspace.json` — the workspace file `codeloom index` reads
- `expected-journeys.json` — the hand-verified answer key (Task 14's `ExpectedJourneysSchema`)
- one sub-folder per repo, trimmed to source + `package.json`/`tsconfig.json` + schema/migration files only

Why vendor a trimmed copy instead of cloning at test time: deterministic, offline, reviewable diffs when an
app is re-vendored at a newer commit, and no dependency on GitHub being reachable in CI (codeloom itself makes
no network calls, and neither does its test suite once these fixtures are committed).

Licences: every vendored app here is MIT or Apache-2.0 (verified by reading its `LICENSE` file directly, not
by trusting a badge) — see each app's `SOURCE.md` for which. `fixtures/evals/<app>/LICENSE` is kept alongside
the trimmed source per that licence's terms. Nothing under `fixtures/evals/` is codeloom's own code.

## How the answer keys were written

Every hop was read from the app's own code, not from codeloom's output:

- `ui-api`: `from` is the function that issues the request (for RealWorld, the `agent.js` method such as
  `Articles.get`, named the way codeloom names object-literal members); `to` is the backend route the
  request reaches, with its full mounted path (`/api/...`).
- `route-handler`: `route` is `<repo>:<METHOD> <path as served>`. Anonymous inline Express callbacks use
  codeloom's synthetic name `<METHOD> <declared path>`; Nest uses `Controller.method`; Next `pages/api`
  uses the default-exported function's name.
- `handler-store`: one entry per distinct (route, table, op) reached from the handler through any service
  call, at the ORM call itself (`prisma.<model>.<op>`, TypeORM `repository.<op>`). Tables use the name the
  schema declares (Prisma model name when there is no `@@map`; TypeORM `@Entity('<name>')`). Nested
  relation writes inside one ORM call (`connect`, `connectOrCreate`, implicit join tables) are not keyed.
- Next `pages/api` methods come from the handler code: a file that never checks `req.method` serves every
  method (`ANY`); `post/[id].ts` serves only `DELETE` (everything else throws).
- Hops the linker is known to miss stay in the key, so recall is an honest number.

## Scores (2026-11-01, gate: precision ≥ 0.95 counting exact+param hops, recall ≥ 0.80, per app and hop type)

`test/evals.test.ts` fails CI if any app drops below the gate. Cells are found/expected, precision, recall.

| App | ui-api | route-handler | handler-store |
|---|---|---|---|
| prisma-rest-nextjs | 4/4, 100%, 100% | 5/5, 100%, 100% | 5/5, 100%, 100% |
| realworld | 22/22, 100%, 100% | 21/21, 100%, 100% | 32/32, 100%, 100% |
| realworld-nest | 0/0 (no UI) | 4/4, 100%, 100% | 3/3, 100%, 100% |

Note: realworld's 22 ui-api hops come from call-entry chains (`call:` — the call site that matches the
route), not from page chains. Its pages reach the calls through class lifecycle methods and Redux dispatch,
which codeloom does not follow yet, so `codeloom check` lists them as "not reached from any page".
