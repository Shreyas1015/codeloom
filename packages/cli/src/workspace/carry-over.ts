import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import { JourneysFileSchema } from "../store/schemas.js";
import { SPECS_FILE, SpecsFileSchema } from "../store/specs.js";
import { TOURS_DIR } from "../store/tours.js";
import { VIEWS_DIR } from "../store/views.js";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a 0.5 user's lone repo kept in its own `.codeloom/` (indexed without init, so the repo was its own
 * workspace) and now belongs to its group (0.6 §1): journeys, tours, views and confirmed specs. Copied into
 * `groupRoot`'s `.codeloom/` — the repo's files are left as they are — and never over the group's own: a
 * journey or spec id the group already has, or a tour/view file it already has, is kept. Returns one line
 * per thing carried over (empty when nothing was). A file that cannot be read is skipped. */
export function carryOverRepoData(repoAbs: string, groupRoot: string): string[] {
  const from = join(repoAbs, CODELOOM_DIR);
  const to = join(groupRoot, CODELOOM_DIR);
  if (!existsSync(from)) return [];
  const carried: string[] = [];
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // a broken old file: nothing to carry from it
    }
  };

  safely(() => {
    const old = readJson(join(from, FILES.journeys), JourneysFileSchema, { handWritten: true });
    if (!old || old.journeys.length === 0) return;
    const path = join(to, FILES.journeys);
    const current = readJson(path, JourneysFileSchema, { handWritten: true }) ?? { version: 1 as const, journeys: [] };
    const have = new Set(current.journeys.map((j) => j.id));
    const add = old.journeys.filter((j) => !have.has(j.id));
    if (add.length === 0) return;
    writeJsonAtomic(path, { version: 1, journeys: [...current.journeys, ...add] });
    carried.push(plural(add.length, "journey", "journeys"));
  });

  for (const dir of [TOURS_DIR, VIEWS_DIR]) {
    safely(() => {
      const src = join(from, dir);
      if (!existsSync(src)) return;
      for (const e of readdirSync(src, { withFileTypes: true }).filter((x) => x.isFile() && x.name.endsWith(".json")).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const dest = join(to, dir, e.name);
        if (existsSync(dest)) continue;
        mkdirSync(join(to, dir), { recursive: true });
        copyFileSync(join(src, e.name), dest);
        carried.push(`${dir}/${e.name}`);
      }
    });
  }

  safely(() => {
    const old = readJson(join(from, SPECS_FILE), SpecsFileSchema, { handWritten: true });
    if (!old) return;
    const path = join(to, SPECS_FILE);
    const current = readJson(path, SpecsFileSchema, { handWritten: true }) ?? { version: 1 as const, journeys: {} };
    const add = Object.keys(old.journeys).filter((id) => current.journeys[id] === undefined).sort();
    if (add.length === 0) return;
    const journeys = { ...current.journeys };
    for (const id of add) journeys[id] = old.journeys[id]!;
    writeJsonAtomic(path, { version: 1, journeys: Object.fromEntries(Object.entries(journeys).sort(([a], [b]) => (a < b ? -1 : 1))) });
    carried.push(`specs for ${plural(add.length, "journey", "journeys")}`);
  });
  return carried;
}
