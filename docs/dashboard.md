# The codeloom dashboard

A local page that shows your workspace's user journeys and how much of them you understand. Your agent names and edits journeys and writes tours through MCP; the page only records your own progress (seen, toured), and it updates by itself.

## Run it

```sh
codeloom index        # build the map first
codeloom dashboard    # opens http://127.0.0.1:<port>/ in your browser
```

- `--port <n>` picks the port (default: the first free one from 4747).
- `--no-open` prints the URL without opening a browser.
- Stop it with Ctrl+C.

It listens on `127.0.0.1` only. The URL carries a one-time token; after the first visit it lives in a cookie, so copy the printed URL if you open another browser.

## Screens

| Screen | What you see |
|---|---|
| **Home** (`/`) | Counts (files, pages, routes, tables, queues, journeys), the journey you last opened, all journeys with filters, search and sort (`j` / `k`, Enter), and chains no journey names yet. Each is marked Complete (UI → API → DB), API → DB (reaches the database, but no UI code calls it) or Incomplete. |
| **Journey** (`/journeys/<id>`) | UI → API → Code → DB lanes with numbered stops. Lines show real hops only: solid when exact, thinner for a param match, dashed when guessed. Unresolved hops are listed in red. Click a stop (or use ← / →) to see its code. |
| **Map** (`/map`) | One repo at a time: folders → files → functions. Double-click a folder to open it. Pick a journey to highlight its files, or colour by layer. Search jumps to a file. |
| **Tour** (`/journeys/<id>/tour`) | Walk one journey: Flow → Data journey → File notes → Check yourself. See below. |
| **Progress** (`/progress`) | How many journeys you understand, per repo and per area, what needs a re-walk, your recent checks and what is left. See below. |

Home also shows your understood % in the header, a three-step progress strip on each journey row, and the Continue band takes you back to the next tour stop you have not walked. The Journey screen shows your level and a **Start tour** (or **Resume tour**) button.

## Tour mode

Open it with **Start tour** on a journey, or go to `/journeys/<id>/tour`.

- **Flow:** one stop at a time, in the journey's stop order: the explanation on the left, the stop's code on the right. Move with ← / → or the buttons at the bottom; the strip of numbered stops jumps straight to one. The URL keeps your place (`?phase=flow&stop=3`), and so does the browser, for **Resume tour**.
- **Data journey:** the sample input, each step it goes through (with its SQL), and the output.
- **File notes:** traps and notes per file. Traps are set apart.
- **Check yourself:** the tour's 3 questions, your last check result and its history, and a **Check me in Claude** button. It copies `/mcp__codeloom__check-me <journey id>`; paste it into Claude Code. Claude asks the questions one at a time and judges your answers against the code. The page never shows the answers: only a pass in `check-me` marks a journey understood.

Viewing all four parts marks the journey **toured**. Markers you may see:

| Marker | Meaning |
|---|---|
| May be out of date | The stop's file changed since the tour was written. The explanation may no longer match the code. |
| Removed | The tour has a stop the journey no longer has. It is listed last, without code. |
| No tour yet | Copy `/mcp__codeloom__write-tour <journey id>` and run it in Claude Code. |
| For an older journey | The journey was renamed, merged or split, so it has a new id. Open the new journey and ask for a new tour. |

## Progress

- **Seen:** you opened the journey. **Toured:** you viewed all four parts of its tour. **Understood:** you passed `check-me`.
- The page shows understood, toured and seen per repo (bars on one scale, so a bigger repo has a longer bar) and per area, what is left grouped by area, and the next journey to try.
- **Needs a re-walk:** journeys you understood whose code changed since. Only the changed stops are listed, each linked to that stop in Tour mode. Pass `check-me` again to count it as understood.
- Your progress is kept on this computer only, in `~/.codeloom/progress/` (the page shows the exact file). It is never written into your repos.

## Messages you may see

| Message | What to do |
|---|---|
| Not indexed yet | Run `codeloom index`. The page updates by itself when it finishes. |
| No codeloom workspace here | Run `codeloom init` in your repo or folder of repos. |
| A data file is broken | Read the message, then run `codeloom doctor`. |
| Map is behind your code | Run `codeloom index`. |
| Add codeloom to your agent | Run `codeloom init`; it adds codeloom to `.mcp.json`. |
| Session expired | Run `codeloom dashboard` again and open the new URL. |
| Live updates paused | The page lost its connection to `codeloom dashboard` and is reconnecting. |
| Your progress file can't be read | Run `codeloom doctor`. codeloom does not overwrite a broken progress file. |

## Not yet

Spec badges, custom views and team-shared progress come later.
