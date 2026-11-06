---
name: codeloom dashboard
description: A local, read-only dashboard that shows a codebase as user journeys you walk stop by stop.
colors:
  gallery-white: "#F3F4F1"
  ink: "#1A1D1C"
  card-white: "#FFFFFF"
  viridian-wall: "#1F4D45"
  viridian-wall-active: "#2A5F55"
  viridian-wall-border: "#3A6E63"
  wall-text: "#D5E5DF"
  wall-text-muted: "#BCD5CC"
  ochre-stop: "#E3A72F"
  ochre-ink: "#3A2A06"
  ochre-wash: "#FBF0D6"
  deep-ochre-ring: "#8F6410"
  oxblood: "#B5483D"
  oxblood-wash: "#F7E3E0"
  sage-mist: "#E8EBE6"
  slate-caption: "#5C6661"
  hairline: "#D9DDD8"
  connector-tan: "#94804E"
  success-green: "#3E8A6E"
  success-wash: "#DDEEE6"
  lane-ui-blue: "#2F5E9E"
  lane-ui-wash: "#E3ECF8"
  lane-api-viridian: "#1F4D45"
  lane-api-wash: "#E0ECE8"
  lane-code-stone: "#5E5950"
  lane-code-wash: "#E9E6E0"
  lane-db-umber: "#8A5A2B"
  lane-db-wash: "#F3E9DE"
  lane-queue-umber: "#B07E4A"
  lane-queue-wash: "#F8F0E6"
  map-canvas: "#EEF0EC"
typography:
  display:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.35
  stop-title:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  count:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  body:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  caption:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.35
  code:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  pill: "4px"
  sm: "6px"
  md: "8px"
  stop: "9px"
  lane: "10px"
  card: "12px"
  full: "9999px"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "22px"
  gutter: "36px"
components:
  button-primary:
    backgroundColor: "{colors.viridian-wall}"
    textColor: "{colors.card-white}"
    rounded: "{rounded.sm}"
    height: "36px"
    padding: "8px 16px"
  button-accent:
    backgroundColor: "{colors.ochre-stop}"
    textColor: "{colors.ochre-ink}"
    rounded: "{rounded.sm}"
    height: "36px"
    padding: "8px 16px"
  button-outline:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  stop-roundel:
    backgroundColor: "{colors.ochre-stop}"
    textColor: "{colors.ochre-ink}"
    rounded: "{rounded.full}"
    size: "24px"
  stop-roundel-hollow:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.lane-ui-blue}"
    rounded: "{rounded.full}"
    size: "22px"
  stop-card:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.stop}"
    padding: "8px 10px"
  lane-column:
    backgroundColor: "{colors.lane-ui-wash}"
    textColor: "{colors.lane-ui-blue}"
    rounded: "{rounded.lane}"
    padding: "10px"
  panel:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  input-search:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "36px"
  rail-nav-item:
    backgroundColor: "{colors.viridian-wall}"
    textColor: "{colors.wall-text}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  rail-nav-item-current:
    backgroundColor: "{colors.viridian-wall-active}"
    textColor: "{colors.card-white}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
---

# Design System: codeloom dashboard

## Overview

**Creative North Star: "The Gallery Guide"**

Learning a codebase is walking an exhibition. Every user journey is an exhibit with numbered stops, and the
dashboard is the gallery: a painted viridian wall on the left (the rail), a gallery-white floor for the work,
and ochre audio-guide roundels that number every stop. Names read like wall labels: short, bold, with a quiet
caption under them. Real paths, lines and SQL sit beside them in a monospace, because the product's promise is
"follow the data", not abstractions.

This is an Operate surface: a developer spends 20 to 60 minutes in it next to a terminal. Character lives in
precise details (the roundels, the lane hues, the hairline count strip, the confidence of every connector), not
in decoration. It is light-only, dense but calm, and every number lines up. It refuses the grey stat-card
developer dashboard with a folder tree.

**Key Characteristics:**
- Viridian rail as the painted wall; gallery-white ground; white panels with 1px hairlines.
- Ochre numbered roundels are the one signature; nothing else uses ochre fill.
- Four lane hues (UI blue, API viridian, Code stone, DB umber) tell where a stop lives, on every screen.
- Connectors carry confidence: solid for exact, thin for a path-param match, dashed for a guess. A guess is
  never drawn as fact.
- Oxblood is reserved for errors and hops codeloom could not follow.
- Schibsted Grotesk for words, JetBrains Mono only for code, paths, lines, routes and SQL.

## Colors

A quiet mineral palette (gallery white, slate, hairline grey) carrying one painted wall colour, one signal
colour and four lane hues.

### Primary
- **Viridian Wall** (`viridian-wall`): the rail's ground, primary buttons, the Continue band, the API lane's
  ink. It is the room you stand in, so it frames the work instead of competing with it.

### Secondary
- **Ochre Stop** (`ochre-stop`): the audio-guide roundel. Filled ochre means "this is stop n" on Journey and
  Map; the selected stop adds a soft ochre halo. Also the text-selection colour and the accent button.
- **Deep Ochre Ring** (`deep-ochre-ring`): the focus ring on the light ground, dark enough to read at 3:1 on
  gallery white and on white panels. On the viridian wall the focus ring is Ochre Stop instead.

### Tertiary
- **Lane hues**: `lane-ui-blue`, `lane-api-viridian`, `lane-code-stone`, `lane-db-umber` (queue uses the lighter
  `lane-queue-umber` ring with umber ink). Each hue has a wash (`*-wash`) for lane grounds and Map layer cards.
  Every lane ink reads at 4.5:1 or better on its own wash.
- **Oxblood** (`oxblood`, `oxblood-wash`): errors, "orphaned", unresolved hops (always with a dashed edge).

### Neutral
- **Gallery White** (`gallery-white`): the page ground.
- **Card White** (`card-white`): panels, stop cards, inputs.
- **Ink** (`ink`): text and the heavy top rule of the count strip.
- **Slate Caption** (`slate-caption`): captions, secondary text, inactive tabs (5.6:1 on gallery white).
- **Sage Mist** (`sage-mist`): muted fills, table header tint, code chips.
- **Hairline** (`hairline`): every 1px border and divider.
- **Connector Tan** (`connector-tan`): wires between stops and Map edges (3:1 on the ground and every lane
  wash).
- **Wall Text / Wall Text Muted** (`wall-text`, `wall-text-muted`): text on the viridian rail.

### Named Rules
**The One Signature Rule.** Ochre fill means a numbered stop and nothing else. Never use it for a badge, a chart
or a decorative accent.

**The Honest Roundel Rule.** A filled roundel claims something. On Home, roundels are hollow and ringed in their
lane hue: Home names the stops, it never claims you walked them. In Tour mode's stop strip, stops you walked are
filled, the one you stand at is haloed, and the rest stay hollow in their lane hue.

**The Oxblood Rule.** Oxblood appears only for errors and broken or unresolved hops, and always with a second
cue (a dashed edge or the word), never colour alone.

## Typography

**Display / Body Font:** Schibsted Grotesk (self-hosted via @fontsource, weights 400/600/700)
**Mono Font:** JetBrains Mono (self-hosted, 400/600)

**Character:** a compact grotesk that reads like museum wall-label lettering: tight, bold names over quiet
captions. The mono is a working tool for data, never a "technical" costume.

### Hierarchy
- **Display** (700, 32px, 1.1, -0.03em): one per screen, the workspace or journey name (the nameplate).
- **Headline** (700, 20px, -0.02em): section titles ("User journeys", "Unnamed chains").
- **Title** (700, 15px): inspector headings, journey names in rows (15px bold), the Continue band title.
- **Stop title** (700, 28px, 1.15, -0.02em): the stop's name at the head of a Tour Flow stop, beside the 56px
  roundel (its numeral 22px). Only there.
- **Count** (700, 24px, tabular): the six totals in the count strip.
- **Body** (400, 14px, 1.45): base text. Prose blocks cap at 60 to 70ch.
- **Caption** (400, 12.5 to 13.5px): notes under names, facts in the nameplate, empty-state lines.
- **Label** (600, 12px): filter labels, inspector section labels, lane headers (12.5px bold in the lane ink).
- **Code** (JetBrains Mono 12px, 1.65): code blocks; 11.5 to 12.5px for paths, routes, `file:line`, repo ids.

### Named Rules
**The Mono-Means-Data Rule.** Monospace only for code, paths, line numbers, routes, SQL, repo ids and counts in
mono columns. Never for headings or UI words.

**The Tabular Numbers Rule.** Numbers that line up use tabular figures, but only on the number itself: never
set `tabular-nums` on a sentence (it widens commas into a visible gap).

**The Break-at-Slash Rule.** Paths and code names wrap after `/`, `_`, `-`, at a dot before a long part and at
camel humps, never mid-segment; a file's extension and `:line` stay with its name. Clamp to two or three lines
and give the full text as a tooltip.

## Layout

- **Shell:** a 232px viridian rail, then the main column with a 36px side gutter and 28px top padding. Sections
  stack with 22px gaps.
- **Home:** nameplate, a six-cell hairline count strip (3 x 2 below 1024px), the Continue band, then the journey
  list as one white panel of rows on a five-column grid (Journey 2.3fr, Area 0.9fr, Stops 2.2fr, Repos 1fr,
  Confidence 0.9fr). Lists render 200 rows, then "Show more".
- **Journey:** nameplate, Lanes/Chains tabs, then the lanes board beside a 320px sticky stop inspector (from
  1024px). Lanes share the width equally but never drop below 184px; below that the board scrolls sideways
  instead of cutting names.
- **Map:** toolbar (repo segmented buttons, Layers, journey overlay, search), then a canvas beside a 330px
  inspector. Each folder level opens at the largest zoom between 0.9x and 1.1x at which every card fits,
  top-aligned and centred; a level that is wider starts top-left at 0.9x and pans. Cards are 232px wide in
  layer columns 56px apart, at most 10 per column and 150 per level.
- **Tour:** a header row (journey name, the four phase tabs, "Exit tour"), the phase body, and a footer stuck to
  the bottom edge (Previous, the stop strip, Next). Flow: the stop heading, explanation (max 68ch), the stop's
  code and its "Remember this" traps in one column; the stop's data-journey step in a 360px column beside it
  (from 1280px), and no side column when the stop has no step. Check yourself: questions on the left, a 470px
  column with Check me in Claude, Last check and History.
- **Progress:** nameplate ("You understand n of N journeys", a one-line definition, the file path) with the
  legend; then the repo table, By area and What's left beside a 300 to 380px column (Needs a re-walk, Recent
  checks, Next suggested, For older journeys).
- **Density:** rows 12px vertical padding, panels 14 to 18px inner padding, hairlines between rows rather than
  gaps.

## Elevation & Depth

Flat by default: depth comes from tonal layers (gallery white ground, white panels, lane washes) and 1px
hairlines. Shadows are tiny and functional.

### Shadow Vocabulary
- **Stop lift** (`box-shadow: 0 1px 2px rgb(20 40 35 / 0.06)`): stop cards, so they sit on their lane wash.
- **Selection halo** (`box-shadow: 0 0 0 3px rgb(227 167 47 / 0.4)`): the selected stop card or Map card; the
  selected roundel uses a 4px ochre halo. This is a state ring, not elevation.
- **Map stop card** (`0 1px 2px rgb(26 29 28 / 0.08), 0 0 0 3px rgb(227 167 47 / 0.35)`): a card on the journey
  overlay.

### Named Rules
**The Flat-By-Default Rule.** Panels carry a hairline, never a hairline plus a wide soft shadow. A shadow
appears only to lift a stop off its lane or to mark selection.

## Shapes

Gently rounded rectangles with one perfect circle. Panels and Map cards 12px; lane columns 10px; stop cards 9px;
buttons and inputs 6 to 8px; fact pills 4px. The roundel is the only circle (24px on Journey, 22px on Home, 20px
on Map cards), always with a 1.5px ring. Borders are 1px hairlines; dashed borders mean doubt (a guess) or
failure (oxblood). No border-left accent stripes.

## Components

### Buttons
- **Shape:** gently rounded (6px), 36px tall (32px small).
- **Primary:** viridian wall with white text; hover 90% viridian.
- **Accent:** ochre with ochre ink, bold; used once per screen at most (Resume on the Continue band).
- **Outline:** white with a hairline, ink text ("Show on map"); hover darkens the border to slate.
- **Focus:** 2px ring in deep ochre (ochre on the rail), always visible on keyboard focus.

### Stop Roundel (signature)
- Ochre disc, 1.5px ochre ring, dark-ochre mono numeral. Selected: dark rim plus a 4px ochre halo.
  Unresolved: hollow, dashed oxblood ring, oxblood numeral.
- On Home: hollow white disc ringed and numbered in the lane hue, joined by short tan connectors, in lane order;
  past 8 stops the rest fold into one dashed "+N". Each lane's run carries "n Lane stops" for assistive tech.
- Accessible name everywhere: "Stop n: label".

### Lane Column and Stop Card
- A lane is a 10px-rounded wash in its hue with a bold lane name and the repo in mono, both in the lane ink.
- Stop cards are white, 9px corners, a hairline edge and the stop lift. Name 13px semibold (two lines), path
  11.5px mono (three lines), op caption under it. Stops in one lane join with a confidence line; hops across
  lanes are drawn as curved SVG wires in connector tan, with the same set listed in words for screen readers.

### Count Strip
- Six cells on a hairline grid with a 2px ink rule on top. Big tabular number, caption under it. No icons, no
  cards, no trend arrows.

### Progress Strip
- Three segments in one green family: understood (`success-green`), toured (`#8FC1AC`), seen (`#C9DED4`) on a
  sage-mist track, 1px gaps between segments, 3px corners, 14px tall (6px in area cells). Strips in one list
  share a baseline: each track starts at the same left edge and is as long as its total on the list's scale,
  so a bigger repo draws a longer bar. One image whose name reads every count ("3 understood, 2 toured, 1 seen,
  of 10 journeys"); the numbers also sit beside it in text. A legend names the three colours.
- Per journey (Home rows): three 8px steps, filled up to the level, with the word under them. A journey that
  needs a re-walk fills two steps dashed in deep ochre on ochre wash and says "Re-walk n stops" (never ochre
  fill: that is a stop). The Journey nameplate shows the same level as a pill.

### Tour Mode
- **Phase tabs:** one segmented row of links. Current: ink fill, white text. Viewed: success wash with a check
  and "(viewed)" in the name. The place lives in the URL (`?phase=&stop=`).
- **Stop strip** (footer): 24px roundels joined by 14px tan connectors, per the Honest Roundel Rule; each
  carries "Walked" or "Not walked yet" as its description. A removed stop is a hollow dashed oxblood circle.
- **Markers:** "May be out of date" is a 12px dashed slate pill with its reason written next to it (never a
  tooltip only). "Removed" is a dashed oxblood pill plus the word.
- **Remember this:** the stop file's traps under its code, on ochre wash with an alert icon and ochre ink
  (the same treatment as a trap in File notes). Notes that are not traps stay in File notes.
- **Walked note:** on Check yourself, once all four phases are viewed, a success-wash line with a check icon:
  "Toured. Pass the check to count it as understood." (or "Understood. You passed this journey's check.") and
  a "See your progress" link. This is the end of the walk; say it, don't celebrate it.
- **Check yourself shows only the questions.** The expected points are for the agent judging `check-me`; the
  API never sends them and the page never shows them.
- **Check results** read "Passed" or "Not passed" everywhere (Tour's Last check, Progress's Recent checks);
  Not passed is in oxblood on Progress, always with the words.

### Confidence Line
- Exact: 2px solid tan. Param: 1px solid tan. Guess: 1.5px dashed slate with the reason as a tooltip (focusable).
  Unresolved: dashed oxblood. Home shows the worst confidence as the same short line plus a word.

### Inputs / Fields
- White, hairline border, 6px corners, 36px tall; native selects for filters. Focus: deep-ochre ring.

### Navigation (rail)
- Brand mark in ochre, workspace card with a wall-border hairline, nav items with counts in mono on the right.
  Current item: lighter viridian fill, white semibold text. Repo list with lane-tinted dots. Footer chip for MCP
  status and "live updates paused".

### Map Cards
- Folder and file cards 232px, 12px corners, 1.5px edge. Layer overlay paints the card in its lane wash and ink.
  Journey overlay rings stop cards in ochre and dims the rest (frame and icons only, never the text).

## Do's and Don'ts

### Do:
- **Do** number every stop with an ochre roundel on Journey and Map, and with a hollow lane-ringed roundel on Home.
- **Do** keep lane hues consistent across Home roundels, Journey lanes, Map layer cards and the rail repo dots.
- **Do** draw a hop's confidence in its line (solid, thin, dashed) and explain a guess in words.
- **Do** wrap paths at `/` and names at humps; give the full text as a tooltip.
- **Do** keep focus visible: when a class removes the outline, add `outline-solid` back on `focus-visible`
  (Tailwind v4's `outline-none` zeroes the outline style).
- **Do** keep text at 4.5:1 or better; captions use Slate Caption, never a lighter grey.
- **Do** respect reduced motion: transitions are 150ms colour/opacity changes and switch off under
  `prefers-reduced-motion`.

### Don't:
- **Don't** use ochre fill for anything but a stop, and don't fill Home roundels until progress exists.
- **Don't** show placeholders or "coming soon" chrome for Views or spec badges.
- **Don't** show a check's expected answers anywhere in the dashboard, or offer any path but a passed
  `check-me` to "understood".
- **Don't** use oxblood without a dashed edge or the word that says what failed.
- **Don't** truncate a stop name to one line with an ellipsis, or break a path in the middle of a segment.
- **Don't** set monospace on headings or UI words, or `tabular-nums` on whole sentences.
- **Don't** add a dark theme, CDN fonts or remote assets: the dashboard is light-only and loads nothing beyond
  127.0.0.1.
- **Don't** add eyebrow labels, stat cards with icons, gradient text or border-left accent stripes.
