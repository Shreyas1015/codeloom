import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The dashboard builds to static files that `codeloom dashboard` serves from 127.0.0.1, or that a
 * hosted PR snapshot serves from `https://<owner>.github.io/<repo>/pr-<n>/` (design spec §7: relative
 * asset links, so the same build works at any path depth — the live server compensates with its own
 * `<base href="/">`, see web/server.ts). In dev, /api goes to a running `codeloom dashboard` (default
 * port 4747). */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Vendors change less often than the app and keep the entry chunk under the 500 kB warning.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return "vendor-tanstack";
          return undefined;
        },
      },
    },
  },
  server: { proxy: { "/api": { target: "http://127.0.0.1:4747" } } },
});
