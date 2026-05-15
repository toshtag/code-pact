import { parse as parseYaml } from "yaml";

export type FrontMatter = {
  tags?: string[];
  applies_to?: string[];
  [key: string]: unknown;
};

export type ParsedDocument = {
  frontMatter: FrontMatter;
  body: string;
};

/**
 * Parses the leading `---` YAML front-matter block from a Markdown string.
 * Only the first block (at the very start of the file) is treated as front-matter.
 * Files that don't start with `---` are returned with an empty frontMatter object.
 */
export function parseFrontMatter(content: string): ParsedDocument {
  if (!content.startsWith("---")) {
    return { frontMatter: {}, body: content };
  }

  // Find the closing ---
  const afterOpen = content.slice(3);
  const closeIndex = afterOpen.indexOf("\n---");
  if (closeIndex === -1) {
    return { frontMatter: {}, body: content };
  }

  const yamlBlock = afterOpen.slice(0, closeIndex).trim();
  const body = afterOpen.slice(closeIndex + 4).replace(/^\n/, "");

  let frontMatter: FrontMatter = {};
  try {
    const parsed = parseYaml(yamlBlock) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontMatter = parsed as FrontMatter;
    }
  } catch {
    // Malformed YAML: treat as no front-matter
  }

  return { frontMatter, body };
}
