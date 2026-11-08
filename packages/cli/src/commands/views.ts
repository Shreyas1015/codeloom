import { existsSync } from "node:fs";
import { deleteView, HOME_VIEW_ID, viewPath, viewSummaries, viewUrl } from "../store/views.js";
import { loadWorkspace } from "../workspace/repos.js";

// `codeloom views list` and `codeloom views reset <id>` (v0.3 spec §3). Views are written only through MCP
// (save_view); the CLI only lists them and deletes one.

/** One line per view: id, title and widget count (or why the file is broken), and its dashboard link. */
export function formatViewsList(start: string): string {
  const { root } = loadWorkspace(start);
  const views = viewSummaries(root);
  if (views.length === 0) return "No views yet. Ask your agent for one with the make-view prompt.";
  const width = Math.max(...views.map((v) => v.id.length));
  return views
    .map((v) => {
      const what = "error" in v
        ? `broken: ${v.error.split("\n").map((l) => l.trim()).filter(Boolean).join(" ")} (fix it by hand or run "codeloom views reset ${v.id}")`
        : `${v.title} (${v.widgets} widget${v.widgets === 1 ? "" : "s"})`;
      const where = v.id === HOME_VIEW_ID ? `${viewUrl(v.id)} (replaces the built-in Home)` : viewUrl(v.id);
      return `${v.id.padEnd(width)}  ${what}  ${"error" in v ? "" : where}`.trimEnd();
    })
    .join("\n");
}

/** Delete a view file. `home` with no file is already the built-in Home (not an error). Unknown view or bad
 * id → CodeloomError (exit 2). */
export function runViewsReset(start: string, id: string): string {
  const { root } = loadWorkspace(start);
  if (id === HOME_VIEW_ID && !existsSync(viewPath(root, id))) return "Home is already the built-in Home.";
  deleteView(root, id);
  return id === HOME_VIEW_ID ? "Deleted the home view: the dashboard shows the built-in Home again." : `Deleted view "${id}".`;
}
