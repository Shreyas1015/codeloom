---
version: 1
slug: "dashboard"
primary_target: "dashboard"
related_targets: []
---

# Surface brief: codeloom dashboard

Scope: the local dashboard app (Home, Journey, Tour, Map, Progress, Views). Visitor mode: Operate. Audience: the author in 20–60 min deep-dive sessions learning a codebase; later OSS devs. Task: pick a user journey, walk it, prove you understand it, see what's left. Build: code-led, React + Vite + React Flow.

## Direction contract

THESIS: Learning a codebase is walking an exhibition: every user journey is an exhibit with numbered stops, and you earn "understood" by passing its check. Refuses the grey stat-card dev dashboard with a folder tree.

OWN-WORLD: Painted gallery wall (deep viridian #1F4D45) as the shell rail; gallery-white ground #F3F4F1; wall-label typography (Schibsted Grotesk, tight, bold names, quiet captions); JetBrains Mono only for paths, lines and SQL; ochre audio-guide roundels #E3A72F as the one signature; lane hues UI blue, API viridian, DB umber; oxblood only for "no spec"/errors.

STORY: The visitor sees how big the product is, which journeys exist, which they understand, then walks one stop by stop down to the SQL, passes the check, and watches the percentage move.

FIRST VIEWPORT: Viridian rail left (brand, workspace, nav with counts, repo list). Main: workspace title + understood %, a hairline six-cell count strip, one "continue" band, then the journey list as wall labels with stop roundels, spec state and a three-segment progress strip.

FORM: Gallery Guide, position 3 of my ordered list (assigned by the roll). Raises: fixed journey nameplate (character catalog), hairline module grid for counts (high-density), fixed-scale progress strip on a shared baseline (botanical folio), columns that never move (split-flap). seed:3975335602dccf63

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
