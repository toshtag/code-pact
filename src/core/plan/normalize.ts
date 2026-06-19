import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { resolveWithinProject } from "../path-safety.ts";
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await recurse(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  await recurse(root);
  return out;
}

async function resolveNormalizePath(cwd: string, relPath: string): Promise<string> {
  try {
    return await resolveWithinProject(cwd, relPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "PATH_OUTSIDE_PROJECT") {
      const e = new Error(
        `${relPath} is not a safe project-contained normalize path: ${(err as Error).message}`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
    throw err;
  }
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
  const lines = s.split("\n").map((line) => {
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

  for (const abs of files) {
    const raw = await readFile(abs, "utf8");
    const kind: NormalizeFileKind = isMarkdownFile(abs) ? "markdown" : "yaml";
    const result =
      kind === "markdown"
        ? normalizeMarkdownContent(raw)
        : normalizeYamlContent(raw);

    if (result.content === raw) continue;

    const rel = relative(opts.cwd, abs);
    changes.push({ path: rel, kind, reasons: result.reasons });

    if (opts.mode === "write") {
      await atomicWriteText(abs, result.content);
      written.push(rel);
    }
  }

  return { mode: opts.mode, changes, written };
}

async function collectTargetFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];

  const designDir = await resolveNormalizePath(cwd, "design");
  if (await pathExists(designDir)) {
    const all = await walkFiles(designDir);
    for (const abs of all) {
      if (isYamlFile(abs) || isMarkdownFile(abs)) files.push(abs);
    }
  }

  const progressRel = relative(cwd, progressPath(cwd)).split(sep).join("/");
  const progress = await resolveNormalizePath(cwd, progressRel);
  if (await pathExists(progress)) files.push(progress);

  files.sort();
  return files;
}
