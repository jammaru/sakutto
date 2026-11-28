import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitSakuttoPrivacy } from "./sakutto-privacy";

// Astro bundles server code into dist/, so import.meta.url cannot point at the
// source tree during a build. Resolve from the project root first, with the
// source-relative path as a fallback for direct script use.
const policyPaths = [
  path.resolve(process.cwd(), "content", "PRIVACY.md"),
  fileURLToPath(new URL("../../content/PRIVACY.md", import.meta.url)),
];

/** The policy ships with the site, so a build needs no network access. */
export async function fetchSakuttoPrivacyMarkdown(): Promise<string> {
  for (const policyPath of policyPaths) {
    try {
      const markdown = await readFile(policyPath, "utf8");
      splitSakuttoPrivacy(markdown);
      return markdown;
    } catch {
      // Try the next location.
    }
  }
  throw new Error("sakutto privacy policy: content/PRIVACY.md is missing or malformed");
}
