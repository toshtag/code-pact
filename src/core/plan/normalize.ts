import {
  readOwnedText,
  listOwnedDirents,
  statOwned,
  statOwnedList,
} from "../project-fs/operations.ts";
import {
  NormalizeTargetPath,
  resolveNormalizeListPath,
  resolveNormalizeReadPath,
  resolveNormalizeWritePath,
} from "../project-fs/authorities/normalize-authority.ts";
import type { OwnedListPath, OwnedReadPath } from "../project-fs/branded-paths.ts";
import { join, relative, sep } from "node:path";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { progressPath } from "../progress/io.ts";

const TRAILING_WHITESPACE = /[ \t]+$/;

export type NormalizeMode = "check" | "write";

export type NormalizeFileKind = "yaml" | "markdown";

export type NormalizeFileChange = {
  /** Path relative to cwd. */
  path: string;
  kind: NormalizeFileKind;
  /** Human-readable list of which normalizations would apply. */
  reasons: string[];
};

export type NormalizeResult = {
  mode: NormalizeMode;
  changes: NormalizeFileChange[];
  /** Files that were actually rewritten. Always empty in check mode. */
  written: string[];
};

async function pathExists(p: OwnedReadPath): Promise<boolean> {
  try {
    await statOwned(p);
    return true;
  } catch {
    return false;
  }
}

async function listPathExists(p: OwnedListPath): Promise<boolean> {
  try {
    await statOwnedList(p);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(rootRel: string, cwd: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(relDir: string): Promise<void> {
    let entries;
    try {
      entries = await listOwnedDirents(await resolveNormalizeListPath(cwd, relDir));
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = join(relDir, entry.name);
      if (entry.isDirectory()) {
        await recurse(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await recurse(rootRel);
  return out;
}

function isYamlFile(p: string): boolean {
  return p.endsWith(".yaml") || p.endsWith(".yml");
}

function isMarkdownFile(p: string): boolean {
  return p.endsWith(".md");
}

function ensureSingleFinalNewline(s: string): string {
  if (s.length === 0) return s;
  const stripped = s.replace(/\n+$/, "");
  return `${stripped}\n`;
}

/**
 * YAML normalization: CRLF -> LF, strip trailing whitespace per line,
 * ensure exactly one trailing newline. Operates entirely on the line
 * stream so YAML comments survive byte-for-byte (no parse / re-stringify).
 */
export function normalizeYamlContent(input: string): {
  content: string;
  reasons: string[];
} {
  const reasons: string[] = [];
  let s = input;
  if (/\r/.test(s)) {
    s = s.replace(/\r\n?/g, "\n");
    reasons.push("crlf");
  }
  let trimmed = false;
  const lines = s.split("\n").map(line => {
    if (TRAILING_WHITESPACE.test(line)) {
      trimmed = true;
      return line.replace(TRAILING_WHITESPACE, "");
    }
    return line;
  });
  if (trimmed) reasons.push("trailing whitespace");
  s = lines.join("\n");
  const finalized = ensureSingleFinalNewline(s);
  if (finalized !== s) reasons.push("final newline");
  return { content: finalized, reasons };
}

/**
 * Markdown normalization: CRLF -> LF and final newline only.
 * Trailing whitespace is preserved because two trailing spaces are a
 * meaningful Markdown hard line break.
 */
export function normalizeMarkdownContent(input: string): {
  content: string;
  reasons: string[];
} {
  const reasons: string[] = [];
  let s = input;
  if (/\r/.test(s)) {
    s = s.replace(/\r\n?/g, "\n");
    reasons.push("crlf");
  }
  const finalized = ensureSingleFinalNewline(s);
  if (finalized !== s) reasons.push("final newline");
  return { content: finalized, reasons };
}

/**
 * Walk `design/` plus the progress log and report (or fix) files that
 * need normalization. Check mode is byte-safe — no writes happen even
 * if every file in the tree needs work. Write mode uses the shared
 * `atomicWriteText` helper so a crash mid-write cannot leave a file
 * half-rewritten.
 */
export async function runNormalize(opts: {
  cwd: string;
  mode: NormalizeMode;
}): Promise<NormalizeResult> {
  const files = await collectTargetFiles(opts.cwd);

  const changes: NormalizeFileChange[] = [];
  const written: string[] = [];

  for (const rel of files) {
    const target = NormalizeTargetPath.parse(rel);
    const raw = await readOwnedText(
      await resolveNormalizeReadPath(opts.cwd, target),
    );
    const kind: NormalizeFileKind = isMarkdownFile(rel) ? "markdown" : "yaml";
    const result =
      kind === "markdown"
        ? normalizeMarkdownContent(raw)
        : normalizeYamlContent(raw);

    if (result.content === raw) continue;

    changes.push({ path: rel, kind, reasons: result.reasons });

    if (opts.mode === "write") {
      await atomicWriteText(
        await resolveNormalizeWritePath(opts.cwd, target),
        result.content,
      );
      written.push(rel);
    }
  }

  return { mode: opts.mode, changes, written };
}

async function collectTargetFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];

  if (await listPathExists(await resolveNormalizeListPath(cwd, "design"))) {
    const all = await walkFiles("design", cwd);
    for (const rel of all) {
      if (isYamlFile(rel) || isMarkdownFile(rel)) files.push(rel);
    }
  }

  const progressRel = relative(cwd, progressPath(cwd)).split(sep).join("/");
  if (
    await pathExists(
      await resolveNormalizeReadPath(cwd, NormalizeTargetPath.parse(progressRel)),
    )
  ) {
    files.push(progressRel);
  }

  files.sort();
  return files;
}
