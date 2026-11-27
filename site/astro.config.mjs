import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "astro/config";

// Astro's Vite environments otherwise discover a tsconfig from the enclosing
// repository. Pin this project's config so builds are self-contained.
const tsconfig = fileURLToPath(new URL("./tsconfig.json", import.meta.url));

export default defineConfig({
  site: "https://sakutto.jammaru.com",
  output: "static",
  trailingSlash: "always",
  build: { inlineStylesheets: "always" },
  devToolbar: { enabled: false },
  compressHTML: true,
  vite: {
    plugins: [
      cloudflare(),
      {
        name: "sakutto-pin-tsconfig",
        configResolved(config) {
          config.tsconfig = tsconfig;
        },
      },
    ],
  },
});
