# The codeloom dashboard

A local page that shows your workspace's user journeys. Read-only: your agent names and edits journeys through MCP, and the page updates by itself.

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

## Not in v0.1

Tours, progress ("understood"), spec badges and custom views come later.
