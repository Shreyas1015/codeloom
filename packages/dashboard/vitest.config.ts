import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: true,
      include: ["test/**/*.test.{ts,tsx}"],
      setupFiles: ["test/setup.ts"],
      css: false,
    },
  }),
);
