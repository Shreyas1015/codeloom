import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The dashboard builds to static files that `codeloom dashboard` serves from 127.0.0.1.
 * In dev, /api goes to a running `codeloom dashboard` (default port 4747). */
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": { target: "http://127.0.0.1:4747" } } },
});
