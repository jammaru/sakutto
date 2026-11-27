import type { Root } from "mdast";
import { toString } from "mdast-util-to-string";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/**
 * PRIVACY.md is maintained in the public sakutto repository. This site reads it
 * from there, so a change to the policy does not need a pull request here.
 *
 * The contents API is used instead of raw.githubusercontent.com because the raw
 * CDN can keep serving the previous file for minutes after main has moved, while
 * the API already returns the new blob. Its ETag is that blob's SHA, so a
 * revalidation is a 304 and does not re-download the policy.
 */
export const SAKUTTO_PRIVACY_SOURCE =
  "https://api.github.com/repos/jammaru/sakutto/contents/PRIVACY.md";

const API_VERSION = "2022-11-28";

export const sakuttoPrivacyHeaders = (etag?: string) => {
  const headers: Record<string, string> = {
    accept: "application/vnd.github.raw",
    "user-agent": "sakutto-site privacy page",
    "x-github-api-version": API_VERSION,
  };
  const token =
    typeof process !== "undefined" ? process.env.GITHUB_TOKEN?.trim() : "";
  if (token) headers.authorization = `Bearer ${token}`;
  if (etag) headers["if-none-match"] = etag;
  return headers;
};

const englishHeading = "# Privacy policy";
const japaneseHeading = "# プライバシーポリシー";
const absoluteUrl = /^https?:\/\//;

export type SakuttoPrivacy = { english: string; japanese: string };

/**
 * English is `# Privacy policy` up to the Japanese heading, Japanese is that
 * heading to the end of the file. Both sections must be present, so a truncated
 * or malformed response can never replace the page.
 */
export function splitSakuttoPrivacy(markdown: string): SakuttoPrivacy {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const splitAt = text.indexOf(`\n${japaneseHeading}`);
  if (!text.startsWith(englishHeading) || splitAt < 0) {
    throw new Error("sakutto privacy policy is missing a language heading");
  }

  const english = text.slice(0, splitAt).trim();
  const japanese = text.slice(splitAt).trim();
  if (!english || !japanese) {
    throw new Error("sakutto privacy policy has an empty language section");
  }
  return { english, japanese };
}

export async function renderSakuttoPrivacy(markdown: string): Promise<SakuttoPrivacy> {
  const sections = splitSakuttoPrivacy(markdown);
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkPublicLinks)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeStringify);

  const render = async (section: string) => {
    const html = String(await processor.process(section));
    assertPublicLinks(html);
    return html;
  };

  return { english: await render(sections.english), japanese: await render(sections.japanese) };
}

/**
 * The page has nowhere to send a reader who follows a path inside the extension
 * repository, so a link or image that is not an absolute http(s) URL is shown as
 * inline code instead.
 */
function remarkPublicLinks() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (node.type !== "link" && node.type !== "image") return;
      if (absoluteUrl.test(node.url)) return;
      if (index === undefined || !parent) return;

      const value = toString(node).trim() || node.url;
      parent.children[index] = { type: "inlineCode", value };
    });
  };
}

function assertPublicLinks(html: string) {
  for (const match of html.matchAll(/href="([^"]*)"/g)) {
    const href = match[1];
    if (!href.startsWith("https://") && !href.startsWith("http://")) {
      throw new Error(`sakutto privacy policy has a non-public link: ${href}`);
    }
  }
}
