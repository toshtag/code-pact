import { createHash } from "node:crypto";
import { atomicReplaceExistingText } from "../../io/atomic-text.ts";
import {
  readOwnedTextBounded,
  resolveExecuteSourceReadPath,
  resolveExecuteSourceWritePath,
} from "../project-fs/index.ts";
import {
  MAX_NEW_TEXT_BYTES,
  MAX_SOURCE_BYTES,
  type ApplyExactReplacementResult,
  type ExactReplacement,
} from "./types.ts";

export type { ApplyExactReplacementResult, ExactReplacement } from "./types.ts";

export async function applyExactReplacement(
  cwd: string,
  replacement: ExactReplacement,
  expectedSourcePath?: string,
): Promise<ApplyExactReplacementResult> {
  if (
    expectedSourcePath !== undefined &&
    replacement.path !== expectedSourcePath
  ) {
    return { kind: "rejected", reason: "SCOPE_MISMATCH" };
  }

  if (replacement.old_text.length === 0) {
    return { kind: "rejected", reason: "EMPTY_OLD_TEXT" };
  }

  if (Buffer.byteLength(replacement.new_text, "utf8") > MAX_NEW_TEXT_BYTES) {
    return { kind: "rejected", reason: "NEW_TEXT_TOO_LARGE" };
  }

  let readPath;
  let writePath;
  try {
    [readPath, writePath] = await Promise.all([
      resolveExecuteSourceReadPath(cwd, replacement.path),
      resolveExecuteSourceWritePath(cwd, replacement.path),
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "PATH_NOT_OWNED") {
      return { kind: "rejected", reason: "SOURCE_IS_SYMLINK" };
    }
    if (code === "PATH_OUTSIDE_PROJECT") {
      return { kind: "rejected", reason: "SOURCE_OUTSIDE_REPOSITORY" };
    }
    if (code === "ENOENT") {
      return { kind: "rejected", reason: "SOURCE_NOT_FOUND" };
    }
    return {
      kind: "rejected",
      reason: `SOURCE_RESOLUTION_FAILED:${code ?? (error as Error).message}`,
    };
  }

  let originalContent: string;
  try {
    originalContent = await readOwnedTextBounded(readPath, MAX_SOURCE_BYTES);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "OWNED_TEXT_TOO_LARGE") {
      return { kind: "rejected", reason: "SOURCE_TOO_LARGE" };
    }
    if (code === "ENOENT") {
      return { kind: "rejected", reason: "SOURCE_NOT_FOUND" };
    }
    if (code === "ENOTFILE") {
      return { kind: "rejected", reason: "SOURCE_NOT_REGULAR_FILE" };
    }
    if (code === "OWNED_TEXT_INVALID_UTF8") {
      return { kind: "rejected", reason: "SOURCE_NOT_VALID_TEXT" };
    }
    return {
      kind: "rejected",
      reason: `SOURCE_READ_FAILED:${code ?? (error as Error).message}`,
    };
  }

  const actualSha = createHash("sha256")
    .update(Buffer.from(originalContent, "utf8"))
    .digest("hex");
  if (actualSha !== replacement.expected_file_sha256) {
    return { kind: "rejected", reason: "STALE_FILE_SHA" };
  }

  const occurrences = countOccurrences(originalContent, replacement.old_text);
  if (occurrences === 0) {
    return { kind: "rejected", reason: "OLD_TEXT_NOT_FOUND" };
  }
  if (occurrences > 1) {
    return { kind: "rejected", reason: "OLD_TEXT_MULTIPLE_MATCHES" };
  }

  const updatedContent = originalContent.replace(
    replacement.old_text,
    replacement.new_text,
  );

  if (updatedContent === originalContent) {
    return { kind: "rejected", reason: "NO_OP_REPLACEMENT" };
  }

  if (Buffer.from(updatedContent, "utf8").toString("utf8") !== updatedContent) {
    return { kind: "rejected", reason: "INVALID_REPLACEMENT_UTF8" };
  }

  try {
    await atomicReplaceExistingText(writePath, updatedContent, originalContent);
  } catch (error) {
    if ((error as Error).message === "destination changed before write") {
      return { kind: "rejected", reason: "STALE_FILE_SHA" };
    }
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: "rejected",
      reason: `APPLY_FAILED:${code ?? (error as Error).message}`,
    };
  }

  return { kind: "applied", originalContent, appliedContent: updatedContent };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count += 1;
    pos += needle.length;
  }
  return count;
}
