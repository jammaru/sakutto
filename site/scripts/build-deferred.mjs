/**
 * Bundle the post-paint progressive enhancements into a plain public script.
 * Keeping this out of Astro's module graph lets the page load it after the
 * initial paint, off the LCP critical path.
 */
import fs from "node:fs/promises";
import { build } from "vite";

await build({
  configFile: false,
  logLevel: "warn",
  build: {
    outDir: ".deferred",
    emptyOutDir: true,
    minify: true,
    target: "es2020",
    lib: {
      entry: "src/scripts/sakutto-init.ts",
      formats: ["iife"],
      name: "SakuttoDeferred",
      fileName: () => "sakutto-init.js",
    },
  },
});
await fs.copyFile(".deferred/sakutto-init.js", "public/sakutto-init.js");
console.log("wrote public/sakutto-init.js");
