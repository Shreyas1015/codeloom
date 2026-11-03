import { dataError } from "../errors.js";
import { journeyId } from "../linker/chains.js";
import { chainLookup, type MapState } from "../mcp/state.js";
import { compare } from "../util.js";
import { readJson, writeJsonIfChanged } from "./json.js";
import { type Chain, type Journey, type JourneysFile, JourneysFileSchema } from "./schemas.js";

export type JourneyOp =
  | { op: "create"; name: string; area?: string; note?: string; chainIds: string[] }
  | { op: "update"; id: string; name?: string; area?: string; note?: string }
  | { op: "merge"; ids: string[]; name: string; area?: string; note?: string }
  | { op: "split"; id: string; parts: Array<{ name: string; area?: string; note?: string; chainIds: string[] }> }
  | { op: "delete"; id: string };

export interface JourneyOpsResult {
  journeys: Journey[];
  created: string[];
  updated: string[];
  deleted: string[];
}

class OpError extends Error {}

function cleanName(name: string | undefined, what = "name"): string {
  const t = (name ?? "").trim();
  if (!t) throw new OpError(`${what} must not be empty`);
  return t;
}

function uniqSorted(ids: string[]): string[] {
  return [...new Set(ids)].sort(compare);
}

/** Pure. Applies ops in order to a copy; on any error throws dataError("ops[i]: …") and returns nothing.
 * New journeys get id = journeyId(sorted chainIds), status "ok", area/note "" by default. Journey ids are
 * fixed at creation: update never changes one; merge and split create new journeys and delete the old.
 * Output sorted by id; created/updated/deleted compare the result with the input (sorted). */
export function applyJourneyOps(
  journeys: Journey[], ops: JourneyOp[], knownChains: Set<string> | ReadonlyArray<Pick<Chain, "id" | "aliases">>,
): JourneyOpsResult {
  const known = chainLookup(knownChains instanceof Set ? [...knownChains].map((id) => ({ id })) : knownChains);
  const byId = new Map<string, Journey>(journeys.map((j) => [j.id, { ...j, chainIds: [...j.chainIds] }]));

  const get = (id: string): Journey => {
    const j = byId.get(id);
    if (!j) throw new OpError(`unknown journey id "${id}"`);
    return j;
  };
  const add = (name: string, chainIds: string[], area?: string, note?: string): void => {
    const sorted = uniqSorted(chainIds);
    const id = journeyId(sorted);
    if (byId.has(id)) throw new OpError(`a journey with these chains already exists (${id}, "${byId.get(id)!.name}")`);
    byId.set(id, { id, name, area: area ?? "", note: note ?? "", chainIds: sorted, status: "ok" });
  };

  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case "create": {
          const name = cleanName(op.name);
          if (op.chainIds.length === 0) throw new OpError("chainIds must name at least one chain");
          // H11: an id that now exists only as a chain's alias is stored as that chain's current id.
          const resolved = known.resolve(op.chainIds);
          if (resolved.missing.length > 0) throw new OpError(`unknown chain id(s): ${resolved.missing.join(", ")}`);
          add(name, resolved.chains.map((c) => c.id), op.area, op.note);
          break;
        }
        case "update": {
          const j = get(op.id);
          if (op.name !== undefined) j.name = cleanName(op.name);
          if (op.area !== undefined) j.area = op.area;
          if (op.note !== undefined) j.note = op.note;
          break;
        }
        case "merge": {
          const name = cleanName(op.name);
          if (new Set(op.ids).size !== op.ids.length) throw new OpError("merge lists a journey id more than once");
          if (op.ids.length < 2) throw new OpError("merge needs at least 2 journey ids");
          const olds = op.ids.map(get);
          for (const o of olds) byId.delete(o.id);
          add(name, olds.flatMap((o) => o.chainIds), op.area, op.note);
          break;
        }
        case "split": {
          const j = get(op.id);
          if (op.parts.length < 2) throw new OpError("split needs at least 2 parts");
          const own = new Set(j.chainIds);
          const seen = new Set<string>();
          const names = op.parts.map((p, k) => {
            const name = cleanName(p.name, `parts[${k}].name`);
            if (p.chainIds.length === 0) throw new OpError(`parts[${k}] names no chains`);
            const partSeen = new Set<string>();
            for (const c of p.chainIds) {
              if (!own.has(c)) throw new OpError(`parts[${k}]: chain ${c} is not in journey ${j.id}`);
              if (partSeen.has(c)) throw new OpError(`chain ${c} is listed twice in part ${k}`);
              partSeen.add(c);
              if (seen.has(c)) throw new OpError(`chain ${c} is in more than one part`);
              seen.add(c);
            }
            return name;
          });
          const missing = j.chainIds.filter((c) => !seen.has(c));
          if (missing.length > 0) throw new OpError(`chain(s) not in any part: ${missing.join(", ")}`);
          byId.delete(j.id);
          op.parts.forEach((p, k) => add(names[k]!, p.chainIds, p.area, p.note));
          break;
        }
        case "delete":
          byId.delete(get(op.id).id);
          break;
      }
    } catch (err) {
      if (err instanceof OpError) throw dataError(`ops[${i}]: ${err.message}`);
      throw err;
    }
  });

  const before = new Map(journeys.map((j) => [j.id, JSON.stringify(j)]));
  const out = [...byId.values()].sort((a, b) => compare(a.id, b.id));
  const created: string[] = [];
  const updated: string[] = [];
  for (const j of out) {
    const old = before.get(j.id);
    if (old === undefined) created.push(j.id);
    else if (old !== JSON.stringify(j)) updated.push(j.id);
  }
  const deleted = journeys.map((j) => j.id).filter((id) => !byId.has(id)).sort(compare);
  return { journeys: out, created, updated, deleted };
}

/** Read journeys.json fresh (hand-written: a bad file is reported, never overwritten), apply the ops
 * against the chain ids in chains.json, validate with JourneysFileSchema and write it atomically (only when
 * the content changes). All or nothing: a bad op writes nothing. A journeys.json with a duplicate journey
 * id is reported as a dataError (nothing is written) rather than silently letting one shadow the other. */
export function saveJourneys(state: MapState, ops: JourneyOp[]): JourneyOpsResult {
  const current = readJson(state.journeysPath, JourneysFileSchema, { handWritten: true });
  const journeys = current?.journeys ?? [];
  const seenIds = new Set<string>();
  for (const j of journeys) {
    if (seenIds.has(j.id)) throw dataError(`duplicate journey id ${j.id} in journeys.json — fix it by hand`);
    seenIds.add(j.id);
  }
  const result = applyJourneyOps(journeys, ops, state.chains);
  const file: JourneysFile = JourneysFileSchema.parse({ version: 1, journeys: result.journeys });
  writeJsonIfChanged(state.journeysPath, file);
  return result;
}
