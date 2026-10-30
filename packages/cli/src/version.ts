import { readFileSync } from "node:fs";

/** codeloom's version, read once from package.json (src/ and dist/ both sit one level below it). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();
