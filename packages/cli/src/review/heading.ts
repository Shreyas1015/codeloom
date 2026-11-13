/** The PR block's first line (design spec §4). Shared between markdown.ts (which renders it) and
 * pr-body.ts (which uses it to pick the REAL codeloom block among several candidate marker pairs when
 * an author's own prose also quotes START/END text — security review round 3 item 1). Its own tiny
 * module so neither of those two files needs to import from the other. */
export const HEADING = "### 🗺 codeloom review map";
