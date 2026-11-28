import { defineConfig } from "cf/config";

/**
 * Static Astro output: no Worker entrypoint, only assets. cf builds the site
 * with Astro and publishes the client build output as an assets-only Worker.
 * The custom domain is documentation for a future real deploy only.
 */
export default defineConfig({
  worker: {
    name: "sakutto-site",
    compatibilityDate: "2026-11-26",
    domains: ["sakutto.jammaru.com"],
  },
});
