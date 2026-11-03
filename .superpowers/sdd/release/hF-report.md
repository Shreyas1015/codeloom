# Hardening F report (H10: hook handlers)

Status: DONE. Branch `feat/h10-hook-handlers` (from 82a308e), not pushed.

## What changed

- `linker/code-index.ts`
  - A hook is a function named `use[A-Z0-9]…`. For each one, the index records `hookReturns`: the key, and what the
    key stands for. That is either a named function (`{ handleSubmit }` or `{ handleSubmit: submit }`, where the name
    is a function or const arrow declared in the hook, or something not declared in the hook at all) or an inline
    function. Inline means `{ k: async () => {…} }`, `{ k() {…} }`, `{ k: useCallback(fn) }`, or a const the hook
    sets to `useCallback(fn)`. Arrow hooks with an expression body (`() => ({ … })`) count too.
  - Callees carry hook info, taken from the nearest declaration in scope. An identifier gets `hook: { hook, key }`
    when it was destructured from `useX()` (aliases like `{ onDelete: remove }` count). A member call `form.x` gets
    `hook: "useX"` when `const form = useX()`.
  - A plain-name JSX ref with hook info is kept, even though the name is not a declared function.
- `linker/resolve-calls.ts`
  - `resolveHookKey` first resolves the hook, locally or through imports and barrels, then looks up its key.
  - A named function resolves to that function, in the hook's file or one it imports.
  - An inline function resolves to the hook symbol, with `ResolvedCall.lines` set to the function's lines.
  - Confidence is always `param`. `via` is `"hook"`, and that holds for JSX refs too.
  - A name or receiver with hook info never falls back to a same-named local function or to the unique-method
    guess.
- `indexer/index-repo.ts`: `CACHE_FORMAT` 22 → 23, because code-index records changed shape.

These cases stay unresolved:
- the hook does not return the key
- the hook returns something that is not an object literal (another hook's result, a variable)
- the hook has mixed returns (one literal, one not)
- the key's value is state, a parameter or a destructured value
- a later `...spread` could override the key
- a `...rest` element
- the name is shadowed by an inner parameter
- the function called is not a hook (`makeHandlers()`)
- the inner name appears twice in the hook's file (so it is ambiguous)

## Tests

`test/hook-handlers.test.ts` has 18 tests:
- every shape: shorthand, renamed key, alias, inline arrow and method, useCallback, `form.x` as a JSX ref and as a
  call, an expression-body hook, a module function or import as the target, a local hook, and a hook through a
  barrel
- the 9 unresolved cases above
- `linkUi` over two repos (UI + API)
- a full `codeloom index` two-repo workspace: page → `<form onSubmit={handleSubmit}>` → the hook's `submit` →
  `createCustomer` → `client(config)` → `POST /customers`. It re-runs byte-identical.

Results:
- `CI=1 pnpm --filter codeloom test`: exit 0. 67 files, 1101 tests passed.
- `pnpm -r typecheck`: exit 0.
- Dashboard: not touched.

## Eval gate (unchanged, 100%)

| app | hop type | expected | found | precision | recall | guesses |
|---|---|---|---|---|---|---|
| prisma-rest-nextjs | ui-api | 4 | 4 | 100% | 100% | 0 |
| prisma-rest-nextjs | route-handler | 5 | 5 | 100% | 100% | 0 |
| prisma-rest-nextjs | handler-store | 5 | 5 | 100% | 100% | 0 |
| realworld | ui-api | 22 | 22 | 100% | 100% | 0 |
| realworld | route-handler | 21 | 21 | 100% | 100% | 0 |
| realworld | handler-store | 32 | 32 | 100% | 100% | 0 |
| realworld-nest | ui-api | 0 | 0 | 100% | 100% | 0 |
| realworld-nest | route-handler | 4 | 4 | 100% | 100% | 0 |
| realworld-nest | handler-store | 3 | 3 | 100% | 100% | 0 |

The demo-shop answer key is also at precision 1.0 and recall 1.0, with zero guesses.

## Concerns

- `CACHE_FORMAT` is now 23. If the other agent bumps it too, the controller has to merge the two bumps.
- Behaviour change, for better precision:
  - `x.m()` on `const x = useX()` no longer gets a unique-method guess.
  - A destructured hook name no longer resolves to an unrelated function in the same file that happens to share
    its name.
- Inline targets point at the hook symbol, and `ResolvedCall.lines` holds the arrow's lines. `chains.ts` (not mine to
  edit) does not read `lines` yet, so a chain stop shows the hook's line, not the arrow's.
- Things that are not followed:
  - hooks returning arrays (`[value, setter]`)
  - nested destructuring
  - hooks called through a member (`hooks.useX()`)
  - a handler passed as a call argument instead of a JSX ref (`form.onSubmit(handleSubmit)`)
