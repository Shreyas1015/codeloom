# Chain stops record `from`: report

Status: DONE. Branch `worktree-agent-a047817218d88c608` (based on feat/v0.1-plan-3-dashboard @ d8c0291). Not pushed.

## Commits
- 5b1ac99 feat(linker): chain stops record the stop they were reached from (from)
- d49344e feat(mcp): chain stop views pass from through (list_chains, get_journey chains, trace_route); lanes omit it
- 2310c7b feat(evals): scorer pairs each stop with the stop it was reached from (from), falling back to the previous stop
- (this report)

## What changed
- `store/schemas.ts`: `ChainStopSchema.from` = optional non-negative int. Old files without it still parse.
- `linker/chains.ts`: builders record each stop's parent in `Ctx.parents` (a WeakMap). `withFrom` turns
  parents into indices once the final order is known (after manual-link insertion), inside `add`.
  Parents: page path is linear; call -> last path stop; route -> call; handler -> route; function stop ->
  the previous walk step; db/publish -> the stop of the symbol holding the access (last viaPath step);
  consume -> publish; consumer handler -> consume; manual blocks -> the link's source stop (`out[at]`).
  Safety net: a missing or later parent falls back to `i - 1`. I made it throw temporarily and ran
  demo-shop, manual links, queue chains, ui-reach and all eval apps: it never fired.
- Chain ids: not changed. chains.json stays sorted and deterministic (the byte-identical warm and cold tests
  pass). chains.json is not in the indexer cache, so CACHE_FORMAT did not change. No chains.json is committed.
- `mcp/tools/journeys.ts`: `stopView` passes `from` for chain stops (list_chains, get_journey `chains`,
  trace_route). `api-types.ts StopView.from?: number`. `web/api.ts` reuses these tool results, so it needed
  no change.
- `evals/score.ts`: ui-api means a route whose parent is a call. route-handler means a handler whose parent
  is a route. Each stop's segment (route or consumer key) comes from its parent chain (memoised). Files
  without `from` fall back to the previous stop, which keeps the old behaviour.

## Decision to review
- get_journey `lanes` leaves out `from`. Lanes merge and dedupe stops from several chains, so an index into
  one chain would be wrong there. Tests cover this.
- Scorer: a manual route->symbol handler now counts as route-handler even if the route already has a handler.
  Before, it only counted when listed right after the route. The eval apps have no links, so the gate is
  unaffected.

## Tests
- New `test/chain-from.test.ts` (5 tests). On demo-shop: every `from < index` and stop 0 has none. The
  customers and audit_logs stores come from the CustomerService.create stop. Every store's parent is a
  handler/function in the same file. The pay chain's consume comes from the publish, and invoices does not.
  Manual route->route, route->queue and route->symbol stops come from the link's source stop. Old files
  without `from` parse, and `from: -1` is rejected.
- `score.test.ts` +2 (a handler pairs with its own route when an appended route sits between them; a store
  keeps its segment even after a paired consumer). `mcp-journeys`, `mcp-contract` and `web-endpoints`
  were updated for `from`.
- `pnpm --filter codeloom typecheck`: pass. `pnpm --filter @codeloom/dashboard typecheck`: exit 0.
- Full cli suite: exit 0. 59 files, 972 tests passed.
- Eval gate (`test evals`): 100% precision and recall on every hop type, 0 guesses. Answer keys were not edited.

| app | ui-api | route-handler | handler-store |
|---|---|---|---|
| prisma-rest-nextjs | 4/4 | 5/5 | 5/5 |
| realworld | 22/22 | 21/21 | 32/32 |
| realworld-nest | 0/0 | 4/4 | 3/3 |

## Concerns
- Before the typecheck would run, I had to build `@codeloom/core` (`pnpm --filter @codeloom/core build`) in
  this fresh worktree. It is environment-only; no code changed.
