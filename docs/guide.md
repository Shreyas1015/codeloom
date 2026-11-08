# Working with your agent

Tours, progress, specs and views: what your agent writes through MCP, and where it is kept.

## Tours and progress

A **tour** walks you through one journey in four parts: **Flow** (each stop's code beside a plain-language
explanation), **Data journey** (one sample request followed stop by stop down to the SQL), **File notes**
(traps and notes per file) and **Check yourself** (3 questions).

Your agent writes the tour; codeloom never does. Two prompts do the work, in Claude Code:

1. `/mcp__codeloom__write-tour <journey id>`: Claude reads the journey's code with `build_tour_context`,
   writes the tour and saves it with `save_tour`. It may only use the journey's real stops and code.
2. `/mcp__codeloom__check-me <journey id>`: Claude asks you the tour's 3 questions one at a time, judges your
   answers against the code and records the result with `record_check`.

The dashboard shows both commands with a copy button (the journey id is filled in).

**Progress** has three levels per journey:

| Level | How you get it |
|---|---|
| Seen | You opened the journey in the dashboard. |
| Toured | You viewed all four parts of its tour in Tour mode. |
| Understood | You passed `check-me` (all 3 answers acceptable). Nothing else sets it. |

When the code under a journey you understood changes, the journey **needs a re-walk**: the dashboard lists
only the stops whose file changed, and it counts as toured until you pass `check-me` again. A tour stop
whose file changed since the tour was written is marked "may be out of date"; the tour stays usable. Stops
are matched by lane, repo, file and symbol, so a line added above a stop moves it, never removes it.

Where the files live:

| What | Where | Shared? |
|---|---|---|
| Tours | `.codeloom/tours/<journey id>.json` in the workspace root | Committed: team knowledge. Written only by `save_tour`. |
| Your progress | `~/.codeloom/progress/<workspace id>.json` (or under `$CODELOOM_HOME`) | Personal: never in your repo, never committed. |
| Your place in a tour | the browser's local storage | This browser only. |

The workspace id comes from the workspace name and its repo ids, so it stays the same across clones. If you
add or remove a repo, the id changes; `codeloom doctor` lists your earlier progress file for the same
workspace name so you can copy what you need (codeloom never moves it).
`codeloom doctor` reports a broken progress or tour file; codeloom never overwrites one silently.

## Specs and views

**Specs.** On every `codeloom index`, codeloom looks for docs and tickets that may describe each journey,
with no AI and no network:

- **Docs** in each repo (`docs/**`, `README*`, `**/adr/**`, `*.md`, `*.mdx`, `*.txt`, up to 512 KB) that name
  one of the journey's routes (`POST /api/customers`, with `:id`, `{id}` and `[id]` treated alike), pages,
  tables, queues or code names (`CustomerService.create`), as whole words. A name many journeys share (a
  `customers` table) counts for little, and a doc that names only tables or queues comes after any doc that
  names a route, page or code name of the journey.
- **Tickets**: keys like `SHOP-12` in the last 500 commits that changed the journey's stop files (subject,
  body, merged branch name). A commit that touched many journeys' files counts for less, so keys specific
  to the journey come first.

These candidates go to `.codeloom/spec-candidates.json`. They are only hints. Run
`/mcp__codeloom__match-specs <journey id>` (or with no id, for every journey not checked yet): Claude reads
the candidates and the code, keeps only the ones that really describe the journey, each with a one-line
reason, and saves them to `.codeloom/specs.json` (committed, shared with your team). Saving none records
"checked, no spec". Each journey then shows one badge:

| Badge | Meaning |
|---|---|
| Spec linked | Claude linked at least one doc or ticket. |
| Spec candidates | Not checked yet; codeloom found docs or tickets that mention it. |
| No spec | Checked, and nothing describes it. |
| Spec not checked | Not checked, and nothing mentions it. |

codeloom never fetches ticket text. Claude may summarise a ticket with its own tools into the reason.

**Views.** Ask Claude for a dashboard page in plain words with `/mcp__codeloom__make-view <request>`, for
example "customer journeys with no spec". Claude builds it from a fixed set of widgets (counts, a journey
list with filters and sort, a map, progress, recent checks, spec coverage and a markdown note), saves it to
`.codeloom/views/<id>.json` and gives you its link, `/views/<id>`. Views are listed in the dashboard's rail.
A view with the id `home` replaces Home; `codeloom views reset home` brings the built-in Home back.

The dashboard never writes specs or views: only your agent does, through MCP. A view or `specs.json` that
cannot be read never breaks the dashboard: it shows what is wrong and `codeloom doctor` says why.

| What | Where | Shared? |
|---|---|---|
| Spec candidates | `.codeloom/spec-candidates.json` | Committed. Rebuilt by `codeloom index`. |
| Spec links | `.codeloom/specs.json` | Committed. Written only by `save_spec_links`. |
| Views | `.codeloom/views/<id>.json` | Committed. Written only by `save_view`. |
