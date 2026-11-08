import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataError } from "../errors.js";
import { compare } from "../util.js";
import { DOCTOR_HINT, readJson, writeJsonAtomic } from "./json.js";
import { CODELOOM_DIR } from "./paths.js";
import { ConfidenceSchema } from "./schemas.js";
import { sortKeysDeep } from "./tours.js";

// v0.3 spec §3: views Claude builds from a fixed widget set. `.codeloom/views/<id>.json`, committed,
// written only by the save_view MCP tool (and removed by delete_view / `codeloom views reset`).

export const VIEWS_DIR = "views";
export const VIEW_ID_RE = /^[a-z0-9-]{1,40}$/;
/** The view Home renders when it exists and is valid (else the built-in layout). */
export const HOME_VIEW_ID = "home";

/** Where the dashboard shows a view: Home for `home`, else /views/<id>. */
export function viewUrl(id: string): string {
  return id === HOME_VIEW_ID ? "/" : `/views/${id}`;
}

export const VIEW_LIMITS ={ widgets: 24, markdown: 4000, title: 120, description: 500, dir: 500 } as const;

const JOURNEY_OVERLAY_RE = /^journey:j_[0-9a-f]{12}$/;

export const CountsKeySchema = z.enum(["files", "pages", "routes", "tables", "queues", "journeys", "understood", "specLinked"]);
export const SpecStateSchema = z.enum(["linked", "candidates", "none"]);
export const ViewLevelSchema = z.enum(["none", "seen", "toured", "understood", "rewalk"]);
const ByRepoOrArea = z.enum(["repo", "area"]);

export const JourneysFilterSchema = z
  .object({
    area: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    spec: SpecStateSchema.optional(),
    level: ViewLevelSchema.optional(),
    confidence: ConfidenceSchema.optional(),
    complete: z.boolean().optional(),
  })
  .strict();

/** The fixed widget set. Unknown types and unknown keys are rejected (strict), so a typo is caught at save. */
export const WidgetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("counts"), show: z.array(CountsKeySchema).min(1).optional() }).strict(),
  z
    .object({
      type: z.literal("journeys"),
      title: z.string().min(1).max(VIEW_LIMITS.title).optional(),
      filter: JourneysFilterSchema.optional(),
      sort: z.enum(["name", "area", "stops", "confidence", "progress", "spec"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("map"),
      repo: z.string().min(1),
      overlay: z.union([z.literal("layer"), z.string().regex(JOURNEY_OVERLAY_RE, 'overlay must be "layer" or "journey:<journey id>"')]).optional(),
      dir: z.string().min(1).max(VIEW_LIMITS.dir).optional(),
    })
    .strict(),
  z.object({ type: z.literal("progress"), by: ByRepoOrArea.optional() }).strict(),
  z.object({ type: z.literal("checks"), limit: z.number().int().min(1).max(50).optional() }).strict(),
  z.object({ type: z.literal("specCoverage"), by: ByRepoOrArea.optional() }).strict(),
  /** Markdown, rendered by the dashboard without raw HTML. */
  z.object({ type: z.literal("note"), markdown: z.string().min(1).max(VIEW_LIMITS.markdown) }).strict(),
]);
export type Widget = z.infer<typeof WidgetSchema>;
export type WidgetType = Widget["type"];

const ViewBody = {
  id: z.string().regex(VIEW_ID_RE, "a view id is 1 to 40 characters: a-z, 0-9 and -"),
  title: z.string().trim().min(1).max(VIEW_LIMITS.title),
  description: z.string().max(VIEW_LIMITS.description).optional(),
  widgets: z.array(WidgetSchema).min(1).max(VIEW_LIMITS.widgets),
};

/** `.codeloom/views/<id>.json`. */
export const ViewFileSchema = z.object({ version: z.literal(1), ...ViewBody });
export type ViewFile = z.infer<typeof ViewFileSchema>;

/** What the agent sends (save_view): a view without `version` (codeloom sets it; any sent is dropped). */
export const ViewDraftSchema = z.object(ViewBody);
export type ViewDraft = z.input<typeof ViewDraftSchema>;

function checkViewId(id: string): void {
  if (!VIEW_ID_RE.test(id)) throw dataError(`Bad view id "${id}": a view id is 1 to 40 characters: a-z, 0-9 and -.`);
}

export function viewsDir(root: string): string {
  return join(root, CODELOOM_DIR, VIEWS_DIR);
}

export function viewPath(root: string, id: string): string {
  checkViewId(id);
  return join(viewsDir(root), `${id}.json`);
}

/** Missing → null. Bad JSON or shape → CodeloomError (exit 2). Bad id → CodeloomError. */
export function readView(root: string, id: string): ViewFile | null {
  return readJson(viewPath(root, id), ViewFileSchema, { handWritten: true });
}

/** Ids of the view files (valid or not), sorted. Files whose name is not a view id are skipped. */
export function listViews(root: string): string[] {
  const dir = viewsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json") && VIEW_ID_RE.test(e.name.slice(0, -".json".length)))
    .map((e) => e.name.slice(0, -".json".length))
    .sort(compare);
}

/** Files in views/ that are not `<view id>.json` (doctor warns about them). Sorted names. */
export function strayViewFiles(root: string): string[] {
  const dir = viewsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !(e.isFile() && e.name.endsWith(".json") && VIEW_ID_RE.test(e.name.slice(0, -".json".length))))
    .map((e) => e.name)
    .sort(compare);
}

export type ViewSummary =
  | { id: string; title: string; description?: string; widgets: number }
  | { id: string; error: string };

/** A message without readJson's trailing doctor hint (callers add their own). */
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n").filter((l) => l !== DOCTOR_HINT).join("\n");
}

/** Every view: its title and widget count, or the error that makes it unreadable. Sorted by id. */
export function viewSummaries(root: string): ViewSummary[] {
  return listViews(root).map((id) => {
    try {
      const v = readView(root, id)!;
      return { id, title: v.title, ...(v.description !== undefined ? { description: v.description } : {}), widgets: v.widgets.length };
    } catch (err) {
      return { id, error: errorText(err) };
    }
  });
}

/** Validate and write a view atomically (sorted keys; widgets keep their order). Throws CodeloomError
 * (exit 2) and writes nothing on a bad draft. Checking repos and journeys the widgets name is the
 * caller's job (save_view). */
export function saveView(root: string, draft: unknown): { view: ViewFile; replaced: boolean; path: string } {
  const parsed = ViewDraftSchema.safeParse(draft);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw dataError(`The view is not valid:\n${lines.join("\n")}`);
  }
  const view: ViewFile = sortKeysDeep({ version: 1 as const, ...parsed.data });
  const path = viewPath(root, view.id);
  const replaced = existsSync(path);
  writeJsonAtomic(path, view);
  return { view, replaced, path };
}

/** Delete a view file. Missing → CodeloomError (exit 2). Protecting `home` is the caller's choice. */
export function deleteView(root: string, id: string): void {
  const path = viewPath(root, id);
  if (!existsSync(path)) throw dataError(`No view "${id}". Views: ${listViews(root).join(", ") || "none"}.`);
  rmSync(path, { force: true });
}

/** What Home renders: the `home` view when it exists and is valid; otherwise null (the built-in layout),
 * with `error` when the file exists but is broken (Home shows a quiet notice). Never throws. */
export function homeView(root: string): { view: ViewFile | null; error?: string } {
  try {
    return { view: readView(root, HOME_VIEW_ID) };
  } catch (err) {
    return { view: null, error: `${errorText(err)}\n${DOCTOR_HINT}` };
  }
}
