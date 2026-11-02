import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Library error messages embed doc links ("visit https://react.dev/errors/…"). They are text, never
 * fetched, but the built dashboard must hold no external URL at all — so drop the scheme. */
function noExternalUrls(): Plugin {
  return {
    name: "codeloom:no-external-urls",
    apply: "build",
    renderChunk(code) {
      const out = code.replace(/https:\/\/(react\.dev|tanstack\.com)\//g, "$1/");
      return out === code ? null : { code: out, map: null };
    },
  };
}

/** The dashboard builds to static files that `codeloom dashboard` serves from 127.0.0.1.
 * In dev, /api goes to a running `codeloom dashboard` (default port 4747). */
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), noExternalUrls()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": { target: "http://127.0.0.1:4747" } } },
});
