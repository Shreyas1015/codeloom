# codemap — project brief (working name)

An **open-source npm package** that combines the best of **CodeSee** (shut down after GitKraken bought it,
May 2024) and **Understand Anything** (MIT, Claude Code plugin), connected to **Claude / any AI agent
through MCP**. Author: Shreyas Gurav (shreyas1234gurav@gmail.com). Personal open-source project — not Acme
company work, no Jira ticket needed.

This brief captures everything decided so far (research done 2026-10-26 → 10-29 in another session).
Read it fully before proposing anything.

---

## 1. The goal in one paragraph

A developer installs one npm package. It maps their codebase (files, functions, dependencies,
architecture layers, business flows), keeps the map in sync with every commit, and exposes it to Claude
(or any MCP agent) as tools. On top of the map it does what CodeSee did for teams — review maps on pull
requests, guided tours, notes/labels, PR rules (checklists, reviewer routing), and a map of how services
connect — while the analysis itself stays local and cheap (tree-sitter, no AI needed for structure; the
connected agent supplies summaries and explanations).

---

## 2. CodeSee — complete feature list (what we are re-implementing)

CodeSee's core product was **never open source** (its public GitHub repos are side pieces: a GitHub
Action, a .NET dependency scanner, a flame-graph lib, community tools). We **re-implement features, never
copy code**.

1. **Codebase Maps (core)**
   - Auto-generated diagrams of repo structure: files, folders, dependencies; kept in sync as code changes.
   - Expand / collapse / hide parts to trace connections and spot impacts.
   - Labels and colour coding: ownership, tech debt, layers.
   - Notes and comments pinned to files or map areas.
   - Code Tours: step-by-step guided walkthroughs, mainly for onboarding.
   - Shareable in real time; viewers didn't need an account.
   - Use cases: onboarding, refactoring, exploring unfamiliar code, planning, ownership/tech-debt mapping.
2. **Review Maps (PR review)**
   - Auto-generated per pull request: visual diagram of what changed and what it affects.
   - Map image posted on the GitHub PR itself.
   - Review Map Tours: the PR author records a guided path ("start here, then this tricky part").
   - VS Code extension opened Review Maps in the editor.
3. **Code Automations (workflow rules)**
   - Trigger → action rules on pull requests.
   - Auto checklists posted on the PR by a bot; **merge blocked until every item is ticked**.
   - Auto reviewer / team assignment when certain code is touched.
   - Reminders, warnings, alerts before merge; templates such as "Endpoint Checklist".
4. **Service Maps (Enterprise only)**
   - Live diagram of every service and how they connect; endpoints and request flows; self-documenting.
5. **CodeSee AI (beta, Jul 2023, with Microsoft/OpenAI)**
   - Ask in plain language ("How does authentication work?") → text answer + a code map of the connections.
6. **Platform**
   - Languages: JS, TS, Python, Java, Rust, .NET/C#/ASP.NET, Kotlin, Go. GitHub only. Web app + VS Code extension.
   - Claimed to build maps without storing code. Open Source Hub (~12k community).
   - Pricing before shutdown: Community free (OSS unlimited, 3 private collaborators); Business $29/user/mo;
     Enterprise custom (incl. Service Maps).

Sources: docs.codesee.io (overview, review maps, code automations, checklists, VS Code), codesee.io
pages (now parked), TechCrunch Jul 2023, GitKraken acquisition blog, SD Times, Repowise / Koalr
"CodeSee alternatives".

---

## 3. Understand Anything — what it does (our base to fork)

**MIT licensed** (© Yuxiang Lin and Infinite Universe, Inc.) — we may fork, change and publish, keeping
the copyright notice. Installed locally at `~/.claude/plugins/marketplaces/understand-anything/`
(README, source, `docs/`). Repo: github.com/Egonex-AI/Understand-Anything.

| Command | What it does |
|---|---|
| `/understand` | Multi-agent pipeline builds a knowledge graph → `.understand-anything/knowledge-graph.json`; incremental on re-run; `--auto-update` post-commit hook; `/understand <subdir>` for monorepos; `--language` |
| `/understand-dashboard` | Interactive web graph: click a node for code, relationships, plain-English summary; colour-coded layers |
| `/understand-chat` | Ask questions about the codebase |
| `/understand-diff` | Impact of current changes before committing |
| `/understand-explain <file>` | Deep explanation of a file/function |
| `/understand-onboard` | Onboarding guide |
| `/understand-domain` | Business domains → flows → steps graph |
| `/understand-knowledge <wiki>` | Knowledge graph from a markdown wiki |

Also: auto-generated guided tours (dependency-ordered), fuzzy + semantic search, persona-adaptive UI
(junior / PM / power user), layer visualization (API, Service, Data, UI, Utility), 12 language
concepts explained in context, team sharing by committing the graph JSON (git-lfs for 10 MB+).

**Under the hood:** tree-sitter (deterministic: imports, exports, definitions, call sites, inheritance;
fingerprints for incremental updates) + LLM (summaries, tags, layers, domain mapping, tours). Agents:
`project-scanner`, `file-analyzer` (parallel, ≤5 concurrent, 20–30 files/batch), `architecture-analyzer`,
`tour-builder`, `graph-reviewer`, `domain-analyzer`, `article-analyzer`. Works in Claude Code, Codex,
Cursor, Copilot, Gemini CLI, Kiro, etc.

**Gaps vs CodeSee:** no notes/labels/ownership; tours auto-only (no hand-written); diff impact is local
only (nothing posted to PRs); no PR rules/automations; no cross-service map; no live sharing; first full
run is token-heavy.

---

## 4. Comparison (decided)

| Capability | CodeSee | Understand Anything | codemap (target) |
|---|---|---|---|
| Auto codebase map | ✅ files/folders, synced | ✅ files+functions+classes, layers, incremental | ✅ fork UA |
| Diff / PR impact | ✅ Review Maps on GitHub PRs | ⚠️ local `/understand-diff` | ✅ CLI + CI comment (Bitbucket first, then GitHub) |
| Tours | ✅ hand-written | ✅ auto-generated | ✅ both |
| Notes, labels, ownership | ✅ | ❌ | ✅ `.codemap/notes.json`, committed |
| Real-time collaboration | ✅ | ⚠️ commit JSON | later (v1 = git-shared) |
| Plain-language Q&A | ✅ (beta) | ✅ | ✅ via MCP (agent answers) |
| Business-flow view | ❌ | ✅ | ✅ |
| PR rules (checklists, reviewers) | ✅ | ❌ | ✅ rules file |
| Service map across repos | ✅ Enterprise | ❌ | ✅ (hardest — v0.4) |
| Data-level flow (sample data per hop, SQL) | ❌ | ❌ | ✅ **new** — see §6 |
| Where code goes | their cloud | local via your agent | local; agent of your choice |

---

## 5. Architecture (agreed direction)

**One npm package; Claude / any agent connects via MCP.** The package does indexing + graph without AI;
the connected agent provides the AI parts (summaries, tours, answers) — no API keys inside the package.

```
npx codemap init        → config, git hooks, MCP entry for Claude
npx codemap index       → tree-sitter scan → graph.json (incremental, hook-driven)
npx codemap serve       → MCP server (stdio/http): query_graph, impact_of_diff, explain, get_tour,
                          trace_flow, check_automations …
npx codemap dashboard   → local web UI: graph, layers, domain view, tours, notes
npx codemap review <PR> → review map + automations → comment on Bitbucket / GitHub PR
```

| Feature | Source | Effort |
|---|---|---|
| Code graph, layers, search, explain, onboarding, domain view | Fork Understand Anything | low |
| AI-free deterministic analysis | tree-sitter (already in UA) | low |
| Notes, labels, ownership | new: `.codemap/notes.json` committed | medium |
| Hand-written + generated tours | extend UA tours | medium |
| Review Maps on PRs | new: CLI + CI step posting a diagram | medium–high |
| Code Automations | new: rules file (`when: app/services/Zoho/** → checklist: […]`) | medium |
| Service Map across repos | new: link per-repo graphs via HTTP calls, queues, shared tables | high |
| Live collaboration / hosted sharing | needs a server | later |

**Roadmap**
1. **v0.1 (1–2 weeks):** fork UA, add MCP server, publish to npm, verify with Claude Code.
2. **v0.2:** notes, labels, ownership; hand-written tours.
3. **v0.3:** Review Maps + Automations in CI — **Bitbucket first** (author's repos are on Bitbucket; CodeSee
   was GitHub-only), then GitHub.
4. **v0.4:** Service Map across a multi-repo workspace.

**Risks:** first full analysis token cost (keep indexing AI-free, summarise on demand); service-map
accuracy (queue names / URLs in env vars → some manual tagging); keeping up with UA upstream (fork vs
track); packaging/name (own npm scope, not company scope).

---

## 6. Prior art already built: the `feature-tour` skill (bring this into codemap)

The author wanted a CodeSee-like habit **now**, so a Claude Code skill was built and tested:

- Skill: `~/.claude/skills/feature-tour/SKILL.md` + `references/template.md`
- Sample output: `a sample feature-tour file` (Customer profiling, across a
  Next.js UI repo and an AdonisJS backend) · index/habit log `~/code-tours/INDEX.md`
- Trigger: "tour <JIRA-KEY>" after a feature is done.

Output = one Markdown file, 3 parts, simple language:
1. **Flow Tour** — Mermaid flowchart per user action (FE → BE → DB) + numbered stops
   `file — function — what happens (≤12 words)`.
2. **Data Journey** — per route: a fake sample request, then a table of what the data looks like at each
   file down to the actual SQL and response, + a Mermaid sequence diagram. **(Neither CodeSee nor UA does
   this — it is codemap's differentiator.)**
3. **File Notes** — every touched file: `Lines | What it does` (≤10 words per row).
Plus "Remember this" (3–5 traps/invariants) and "Check yourself" (3 questions, hidden answers).

Lessons from the first test (already fixed in the skill): cap size (~250 lines; trim Part 3 first,
then Part 2; Part 1 complete); detect each repo's default branch (`main-v1` ≠ `main`); read from the
remote ref, not the working tree; label repos; note when later tickets changed the code.

**In codemap this becomes:** `codemap tour <branch|PR|key>` (and an MCP tool `feature_tour`), backed by the
graph instead of ad-hoc reading, with the Data Journey as a first-class feature.

---

## 7. Improvement ideas beyond CodeSee (from the discussion)

1. **Tour on merge** — hook/CI: when a PR merges, generate its feature tour automatically.
2. **Trace a real request** — combine with OpenTelemetry traces: show a real request's actual path and
   timings over the static map (author already runs Grafana/Tempo; package `@acme/telemetry` exists).
3. **Impact across tours** — when a file changes, list which feature tours mention it.
4. **Spaced repetition** — weekly quiz from old tours' "Check yourself" (habit building).
5. **DB-aware maps** — link code to tables/columns (migrations + queries) and, optionally, to
   `pg_stat_statements` hot queries (author just did a prod DB performance programme with this).

---

## 8. Author context & preferences

- Works mainly in TypeScript: AdonisJS backends, Next.js frontends, Postgres, RabbitMQ; repos on
  **Bitbucket**. Multi-repo product ("Shopfront": core-service + several UIs) is the natural test bed.
- Wants **plain, simple language** in outputs; short, scannable; real file paths and line numbers.
- Uses Claude Code heavily, with skills/plugins; likes spec → plan → build with review gates.
- **Ask before any `git push`, npm publish, or creating a public repo.** No credentials in the repo.

## 9. Suggested first steps for this session

1. Read this brief; skim Understand Anything's source at `~/.claude/plugins/marketplaces/understand-anything/`
   (structure, how the graph JSON is shaped, how tours are generated).
2. Propose: package name candidates (check npm availability), fork-vs-depend decision, repo layout,
   MCP tool list for v0.1, and the v0.1 acceptance criteria.
3. Get the author's go-ahead, then build v0.1.
