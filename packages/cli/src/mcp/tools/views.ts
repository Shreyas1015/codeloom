import { relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dataError } from "../../errors.js";
import { deleteView, HOME_VIEW_ID, saveView, VIEW_LIMITS, ViewDraftSchema, viewSummaries, viewUrl } from "../../store/views.js";
import { loadWorkspace } from "../../workspace/repos.js";
import { withErrors } from "../result.js";
import type { ServerOptions } from "../server.js";
import { loadMapState } from "../state.js";

// v0.3 spec §3: views built from a fixed widget set, written only through MCP.

/** Validate a view (shape, then the repos and journeys its widgets name) and save it. Writes nothing on
 * any problem. */
export function saveViewTool(start: string, view: unknown): Record<string, unknown> {
  const parsed = ViewDraftSchema.safeParse(view);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw dataError(`The view is not valid:\n${lines.join("\n")}`);
  }
  const state = loadMapState(start);
  const repos = state.ws.repos.map((r) => r.ref.id);
  const journeys = new Set(state.journeys.map((j) => j.id));
  const problems: string[] = [];
  const repoProblem = (at: string, id: string) => {
    if (!repos.includes(id)) problems.push(`${at}: Unknown repo "${id}". Repos in this workspace: ${repos.join(", ")}.`);
  };
  parsed.data.widgets.forEach((w, i) => {
    const at = `widgets.${i}`;
    if (w.type === "map") {
      repoProblem(`${at}.repo`, w.repo);
      if (w.overlay?.startsWith("journey:")) {
        const id = w.overlay.slice("journey:".length);
        if (!journeys.has(id)) problems.push(`${at}.overlay: Unknown journey "${id}". list_specs or get_progress list every journey.`);
      }
    }
    if (w.type === "journeys" && w.filter?.repo !== undefined) repoProblem(`${at}.filter.repo`, w.filter.repo);
  });
  if (problems.length > 0) throw dataError(`The view "${parsed.data.id}" does not fit this workspace:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  const saved = saveView(state.ws.root, parsed.data);
  return {
    id: saved.view.id,
    url: viewUrl(saved.view.id),
    path: relative(state.ws.root, saved.path).split(/[\\/]/).join("/"),
    replaced: saved.replaced,
    widgets: saved.view.widgets.length,
  };
}

export function listViewsTool(start: string): Record<string, unknown> {
  const { root } = loadWorkspace(start);
  return { views: viewSummaries(root).map((v) => ({ ...v, url: viewUrl(v.id) })) };
}

export function deleteViewTool(start: string, id: string): Record<string, unknown> {
  if (id === HOME_VIEW_ID) {
    throw dataError(`The home view is not deleted through MCP. To bring back the built-in Home, run "codeloom views reset home"; to change it, save a new home view with save_view.`);
  }
  const { root } = loadWorkspace(start);
  deleteView(root, id);
  return { id, deleted: true };
}

const WIDGETS_HELP =
  "Widgets (at most " + VIEW_LIMITS.widgets + "): " +
  "counts {show?: [files|pages|routes|tables|queues|journeys|understood|specLinked]}; " +
  "journeys {title?, filter?: {area?, repo?, spec?: linked|candidates|none|unchecked (none = checked, no spec; unchecked = not checked, nothing found), level?: none|seen|toured|understood|rewalk, confidence?: exact|param|guess, complete?}, sort?: name|area|stops|confidence|progress|spec, limit?: 1-200}; " +
  'map {repo, overlay?: "layer" | "journey:<journey id>", dir?}; ' +
  "progress {by?: repo|area}; checks {limit?: 1-50}; specCoverage {by?: repo|area}; " +
  "note {markdown (≤ " + VIEW_LIMITS.markdown + " characters, no raw HTML)}.";

export function registerViewTools(server: McpServer, opts: ServerOptions): void {
  server.registerTool(
    "save_view",
    {
      title: "Save view",
      description:
        "Save a dashboard view to .codeloom/views/<id>.json (committed; replaces a view with that id). `view`: " +
        "{id (a-z, 0-9, -; up to 40), title, description?, widgets}. " + WIDGETS_HELP + " Each widget is " +
        "{type, ...its fields}; unknown types or fields are rejected, and repos and journeys must exist. The id " +
        "`home` replaces the dashboard's Home screen. Returns the view's dashboard link (`url`).",
      inputSchema: { view: ViewDraftSchema },
    },
    withErrors((args: { view: unknown }) => saveViewTool(opts.start, args.view)),
  );

  server.registerTool(
    "list_views",
    {
      title: "List views",
      description:
        "Every saved dashboard view: id, title, description, widget count and dashboard link (`url`), or the " +
        "`error` that makes a view file unreadable. Read only.",
      inputSchema: {},
    },
    withErrors(() => listViewsTool(opts.start)),
  );

  server.registerTool(
    "delete_view",
    {
      title: "Delete view",
      description:
        'Delete a saved dashboard view (.codeloom/views/<id>.json). Not "home": "codeloom views reset home" brings ' +
        "the built-in Home back.",
      inputSchema: { id: z.string().min(1).describe("A view id, as list_views gives it.") },
    },
    withErrors((args: { id: string }) => deleteViewTool(opts.start, args.id)),
  );
}
